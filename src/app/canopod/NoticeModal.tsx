/* What a backgrounded operation has to say for itself.

   A create or delete sent to the background reports its outcome into the
   attention queue; this is the row's detail view. The whole point is the raw
   text — the error and the log tail that led to it — so it is selectable,
   scrollable and one click from the clipboard, not a summarised sentence. */
import { useState } from "react";
import { Alert, Check, Copy } from "../../icons";
import { useStore, type Notice } from "../../store";
import Modal, { Hint, Spacer } from "./Modal";

export default function NoticeModal({ notice, onClose }: { notice: Notice; onClose: () => void }) {
  const dismissNotice = useStore((s) => s.dismissNotice);
  const [copied, setCopied] = useState(false);
  const failed = notice.kind === "error";

  const copy = () => {
    navigator.clipboard?.writeText(notice.detail || notice.title).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      },
      () => setCopied(false),
    );
  };

  return (
    <Modal
      icon={failed ? Alert : Check}
      danger={failed}
      title={notice.title}
      sub={notice.wt}
      wide
      onClose={onClose}
      foot={
        <>
          <Hint>{new Date(notice.ts).toLocaleTimeString()}</Hint>
          <Spacer />
          <button className="cx-btn cx-btn--ghost" onClick={copy} disabled={!notice.detail}>
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? "Copied" : "Copy details"}
          </button>
          <button
            className="cx-btn cx-btn--primary"
            onClick={() => {
              dismissNotice(notice.id);
              onClose();
            }}
          >
            Dismiss
          </button>
        </>
      }
    >
      <div className="cxm-fld">
        <div className="cxm-flab cxm-flab--f">{failed ? "What the operation reported" : "Details"}</div>
        {notice.detail ? (
          <pre className="cx-logdump">{notice.detail}</pre>
        ) : (
          <div className="cxm-fhint">No further detail was reported.</div>
        )}
      </div>
      <div className="cxm-fld">
        <div className="cxm-flab cxm-flab--f">Worktree</div>
        <div className="cxm-fhint" style={{ fontFamily: "var(--mono)" }}>
          {notice.wtKey}
        </div>
      </div>
    </Modal>
  );
}
