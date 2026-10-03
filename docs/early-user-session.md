# Early-user session guide

Use this guide for moderated first-use sessions. Do not record repository names,
paths, source, logs, command text, environment values or credentials in the study
notes. Ask permission before screen or audio recording.

## Participant and setup

- Target: a developer who regularly switches branches or runs coding agents.
- Duration: 30–40 minutes, plus a voluntary 7–14 day follow-up.
- Ask the participant to bring a small repository they may safely use, or use the
  maintained [simple web recipe](../website/content/example-simple-web.md).
- Record Canopod version, OS, install source and project runtime only.
- Start timing when the participant begins installation or repository selection.

## Moderator script

1. Say: “Please install or open Canopod, add the repository, create an isolated
   branch workspace, and get its app running. Think aloud. I will not guide you
   unless you become blocked or choose to stop.”
2. Observe installation, first launch, repository selection and detected defaults.
3. Ask the participant to review commands before accepting them. Do not normalize
   an incorrect suggestion on their behalf.
4. Ask them to create a worktree, complete setup, start the service and open it.
5. Ask them to create a second worktree and run both simultaneously.
6. Seed one safe failure: missing setup marker or occupied test port. Ask them to
   explain the error and recover without losing configuration.
7. Optionally ask them to connect an installed agent and use the read-only first
   task. Record unavailable authentication separately from Canopod connectivity.
8. End by asking what they expected, what felt risky and whether this would replace
   any part of their current branch workflow.

Only intervene after the participant asks, abandons the task, or risks changing
valuable data. Record the intervention before helping.

## Session record

```text
Participant ID:
Date / facilitator:
Canopod version / install source:
OS / project runtime:
Own repository or reference recipe:

Install completed: yes / no / already installed
Workspace completed: yes / no
Second concurrent workspace completed: yes / no
Failure recovered: yes / no / not attempted
Agent task completed: yes / no / unavailable / not attempted

Time to first launch:
Time from repository selection to working app:
Total task time:
Facilitator interventions (time + reason):
Point of abandonment, if any:
Unexpected or unsafe suggestion:
Most confusing screen or phrase:
Participant's stated value:
Participant's top requested change:
Follow-up permission and channel:
```

## Feedback checklist

- [ ] Installation source and version are recorded.
- [ ] Success, failure and abandonment all use the same completion criteria.
- [ ] Setup/download time is not removed from the elapsed time.
- [ ] Every intervention has a timestamp and reason.
- [ ] The first incorrect expectation is captured in the participant's words.
- [ ] Repeated problems are counted by participant, severity and task blocked.
- [ ] No secret, private path, repository name or source content is copied.
- [ ] Product bugs use the existing GitHub bug report; questions and narrative
      feedback use GitHub Discussions.
- [ ] A follow-up is sent only when the participant opted in.

## Follow-up

After 7–14 days, ask: “Did you use Canopod again? If yes, what did you use it for?
If no, what stopped you?” Record the answer, numerator and denominator. Do not
describe a small invited cohort as representative of the broader market.

Rank findings after each batch by affected participants, severity and effort.
Fix repeated activation blockers before broad promotion, then rerun the affected
task with new participants.
