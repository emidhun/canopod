//! Bounded, non-blocking runtime events for attached application clients.
//!
//! This is an in-process primitive, not an authenticated transport. A host must
//! authorize a client before subscribing. There is no replay buffer: subscribe
//! before loading a snapshot, and obtain a fresh snapshot after any gap. The
//! eventual application API owns snapshot reconciliation and authentication.
use crate::runtime::Audience;
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::io::Write;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Weak,
};
use tokio::sync::{mpsc, OwnedSemaphorePermit, Semaphore};

pub const MAX_SUBSCRIBERS: usize = 16;
pub const QUEUE_CAPACITY: usize = 32;
pub const MAX_EVENT_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy)]
pub enum SubscriptionKind {
    /// Application state, service logs/stats, and terminal lifecycle; no PTY bytes.
    Application,
    /// PTY bytes and lifecycle only. Authenticate separately at the host boundary.
    Terminal,
}

impl SubscriptionKind {
    fn accepts(self, audience: Audience, event: &str) -> bool {
        match self {
            Self::Application => !matches!(audience, Audience::Terminals),
            Self::Terminal => {
                matches!(audience, Audience::Terminals | Audience::TerminalState)
                    || event == "terminal:state"
            }
        }
    }
}

#[derive(Clone, Debug)]
pub struct EventFrame {
    pub sequence: u64,
    /// Already encoded once, shared by all matching consumers.
    pub json: Arc<str>,
}

struct Client {
    kind: SubscriptionKind,
    sender: mpsc::Sender<EventFrame>,
    lagged: Arc<AtomicBool>,
}

#[derive(Default)]
struct State {
    sequence: u64,
    next_client: u64,
    clients: HashMap<u64, Client>,
}

struct Inner {
    state: Mutex<State>,
    slots: Arc<Semaphore>,
}

#[derive(Clone)]
pub struct EventHub(Arc<Inner>);

impl Default for EventHub {
    fn default() -> Self {
        Self(Arc::new(Inner {
            state: Mutex::new(State::default()),
            slots: Arc::new(Semaphore::new(MAX_SUBSCRIBERS)),
        }))
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum EventError {
    Busy,
    ResnapshotRequired,
    Closed,
    Oversized,
    SequenceExhausted,
}

pub struct Subscription {
    id: u64,
    hub: Weak<Inner>,
    receiver: mpsc::Receiver<EventFrame>,
    lagged: Arc<AtomicBool>,
    /// Keep the slot until this consumer actually disconnects, even after its
    /// sender is removed. Otherwise stalled connections could retain unlimited
    /// old queues while repeatedly creating replacement subscriptions.
    _slot: OwnedSemaphorePermit,
    pub start_sequence: u64,
}

impl EventHub {
    pub fn subscribe(&self, kind: SubscriptionKind) -> Result<Subscription, EventError> {
        let slot = self
            .0
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| EventError::Busy)?;
        let (sender, receiver) = mpsc::channel(QUEUE_CAPACITY);
        let lagged = Arc::new(AtomicBool::new(false));
        let mut state = self.0.state.lock();
        let id = state
            .next_client
            .checked_add(1)
            .ok_or(EventError::SequenceExhausted)?;
        state.next_client = id;
        state.clients.insert(
            id,
            Client {
                kind,
                sender,
                lagged: lagged.clone(),
            },
        );
        Ok(Subscription {
            id,
            hub: Arc::downgrade(&self.0),
            receiver,
            lagged,
            _slot: slot,
            start_sequence: state.sequence,
        })
    }

    pub fn interested(&self, audience: Audience, event: &str) -> bool {
        self.0
            .state
            .lock()
            .clients
            .values()
            .any(|c| c.kind.accepts(audience, event))
    }

    pub fn has_application_subscribers(&self) -> bool {
        self.0
            .state
            .lock()
            .clients
            .values()
            .any(|c| matches!(c.kind, SubscriptionKind::Application))
    }

    pub fn has_terminal_subscribers(&self) -> bool {
        self.0
            .state
            .lock()
            .clients
            .values()
            .any(|c| matches!(c.kind, SubscriptionKind::Terminal))
    }

    pub fn publish(
        &self,
        audience: Audience,
        event: &str,
        payload: &serde_json::Value,
    ) -> Result<(), EventError> {
        if !self.interested(audience, event) {
            return Ok(());
        }
        #[derive(Serialize)]
        struct Body<'a> {
            event: &'a str,
            payload: &'a serde_json::Value,
        }
        // Recursive JSON encoding is bounded and outside the coordinator lock.
        // Reserve 32 bytes for the sequence field (including a 20-digit u64).
        let mut bytes = LimitedBytes(Vec::new());
        let oversized = serde_json::to_writer(&mut bytes, &Body { event, payload }).is_err()
            || bytes.0.len() > MAX_EVENT_BYTES - 32;
        let mut state = self.0.state.lock();
        if !state
            .clients
            .values()
            .any(|c| c.kind.accepts(audience, event))
        {
            return Ok(());
        }
        if oversized {
            state.clients.retain(|_, client| {
                if client.kind.accepts(audience, event) {
                    client.lagged.store(true, Ordering::Release);
                    false
                } else {
                    true
                }
            });
            return Err(EventError::Oversized);
        }
        let sequence = state
            .sequence
            .checked_add(1)
            .ok_or(EventError::SequenceExhausted)?;
        state.sequence = sequence;
        let encoded = String::from_utf8(bytes.0).expect("serde JSON is UTF-8");
        let frame = EventFrame {
            sequence,
            json: format!("{{\"sequence\":{sequence},{}", &encoded[1..]).into(),
        };
        // Sequence allocation and enqueueing share one brief lock, preserving
        // ordering even when process-reader threads publish concurrently.
        state.clients.retain(|_, client| {
            if !client.kind.accepts(audience, event) {
                return true;
            }
            match client.sender.try_send(frame.clone()) {
                Ok(()) => true,
                Err(mpsc::error::TrySendError::Full(_)) => {
                    client.lagged.store(true, Ordering::Release);
                    false
                }
                Err(mpsc::error::TrySendError::Closed(_)) => false,
            }
        });
        Ok(())
    }
}

struct LimitedBytes(Vec<u8>);
impl Write for LimitedBytes {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > MAX_EVENT_BYTES.saturating_sub(self.0.len()) {
            return Err(std::io::Error::other("event byte limit exceeded"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Subscription {
    pub async fn recv(&mut self) -> Result<EventFrame, EventError> {
        if self.lagged.load(Ordering::Acquire) {
            return Err(EventError::ResnapshotRequired);
        }
        let frame = self.receiver.recv().await;
        // Check again after waiting: a producer can have overflowed this queue
        // while the consumer was waiting for its next poll.
        if self.lagged.load(Ordering::Acquire) {
            return Err(EventError::ResnapshotRequired);
        }
        frame.ok_or(EventError::Closed)
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        if let Some(hub) = self.hub.upgrade() {
            hub.state.lock().clients.remove(&self.id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn terminal_broadcast_filter_and_oversized_isolation() {
        let hub = EventHub::default();
        let mut app = hub.subscribe(SubscriptionKind::Application).unwrap();
        let mut term = hub.subscribe(SubscriptionKind::Terminal).unwrap();
        hub.publish(Audience::All, "terminal:state", &serde_json::Value::Null)
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), term.recv()).await.unwrap().unwrap();
        app.recv().await.unwrap();
        hub.publish(Audience::All, "tree:changed", &serde_json::Value::Null)
            .unwrap();
        app.recv().await.unwrap();
        assert!(term.receiver.is_empty());
        assert_eq!(
            hub.publish(
                Audience::Terminals,
                "terminal:data",
                &serde_json::json!("x".repeat(MAX_EVENT_BYTES))
            ),
            Err(EventError::Oversized)
        );
        assert_eq!(
            term.recv().await.unwrap_err(),
            EventError::ResnapshotRequired
        );
        hub.publish(Audience::All, "tree:changed", &serde_json::Value::Null)
            .unwrap();
        app.recv().await.unwrap();
    }

    #[tokio::test]
    async fn slow_consumer_cannot_block_or_grow_the_producer() {
        let hub = EventHub::default();
        let mut slow = hub.subscribe(SubscriptionKind::Application).unwrap();
        let mut fast = hub.subscribe(SubscriptionKind::Application).unwrap();
        for n in 0..QUEUE_CAPACITY + 5 {
            hub.publish(Audience::All, "tree:changed", &serde_json::json!(n))
                .unwrap();
            assert_eq!(fast.recv().await.unwrap().sequence, (n + 1) as u64);
        }
        assert_eq!(
            slow.recv().await.unwrap_err(),
            EventError::ResnapshotRequired
        );
        assert_eq!(hub.0.state.lock().clients.len(), 1);
    }

    #[tokio::test]
    async fn oversized_state_requires_rehydration_and_never_enters_a_queue() {
        let hub = EventHub::default();
        let mut client = hub.subscribe(SubscriptionKind::Application).unwrap();
        assert_eq!(
            hub.publish(
                Audience::All,
                "tree:changed",
                &serde_json::json!("x".repeat(MAX_EVENT_BYTES))
            ),
            Err(EventError::Oversized)
        );
        assert_eq!(
            client.recv().await.unwrap_err(),
            EventError::ResnapshotRequired
        );
        assert!(client.receiver.is_empty());
    }

    #[test]
    fn subscriber_limit_applies_even_to_evicted_slow_consumers() {
        let hub = EventHub::default();
        let mut clients: Vec<_> = (0..MAX_SUBSCRIBERS)
            .map(|_| hub.subscribe(SubscriptionKind::Application).unwrap())
            .collect();
        for _ in 0..QUEUE_CAPACITY + 1 {
            hub.publish(Audience::All, "tree:changed", &serde_json::Value::Null)
                .unwrap();
        }
        assert!(hub.0.state.lock().clients.is_empty());
        assert!(matches!(
            hub.subscribe(SubscriptionKind::Application),
            Err(EventError::Busy)
        ));
        clients.pop();
        assert!(hub.subscribe(SubscriptionKind::Application).is_ok());
    }

    #[tokio::test]
    async fn application_subscribers_never_receive_pty_bytes() {
        let hub = EventHub::default();
        let mut app = hub.subscribe(SubscriptionKind::Application).unwrap();
        let mut terminal = hub.subscribe(SubscriptionKind::Terminal).unwrap();
        hub.publish(
            Audience::Terminals,
            "terminal:data",
            &serde_json::json!("bytes"),
        )
        .unwrap();
        assert_eq!(terminal.recv().await.unwrap().sequence, 1);
        assert!(app.receiver.is_empty());
        hub.publish(
            Audience::TerminalState,
            "terminal:exit",
            &serde_json::json!({"id": "term"}),
        )
        .unwrap();
        assert_eq!(terminal.recv().await.unwrap().sequence, 2);
        assert_eq!(app.recv().await.unwrap().sequence, 2);
    }

    #[tokio::test]
    async fn concurrent_publishers_deliver_in_sequence_order() {
        let hub = EventHub::default();
        let mut client = hub.subscribe(SubscriptionKind::Application).unwrap();
        let threads: Vec<_> = (0..4)
            .map(|_| {
                let hub = hub.clone();
                std::thread::spawn(move || {
                    for _ in 0..4 {
                        hub.publish(Audience::All, "status", &serde_json::Value::Null)
                            .unwrap();
                    }
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        for sequence in 1..=16 {
            assert_eq!(client.recv().await.unwrap().sequence, sequence);
        }
    }
}
