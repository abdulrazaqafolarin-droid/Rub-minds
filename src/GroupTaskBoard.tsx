import { useEffect, useMemo, useState, type FormEvent } from "react";
import { AlertCircle, Check, Clock3, ListChecks, Plus, RefreshCw, Send, UserRound } from "lucide-react";
import {
  assignGroupTask,
  cancelGroupTask,
  claimGroupTaskAsHuman,
  createGroupTask,
  listGroupTaskDependencies,
  listGroupTaskReviews,
  listGroupTaskSubmissions,
  listGroupTasks,
  reviewGroupTask,
  submitGroupTaskResultAsHuman,
  subscribeToGroupTasks,
  type CloudParticipant,
  type GroupTask,
  type GroupTaskDependency,
  type GroupTaskReview,
  type GroupTaskSubmission,
} from "./cloudRooms";
import "./group-task-board.css";

type Props = {
  roomId: string;
  participants: CloudParticipant[];
  currentHumanParticipantId: string;
  isGroupOwner: boolean;
};

const statusLabels: Record<GroupTask["status"], string> = {
  backlog: "Backlog",
  assigned: "Assigned",
  in_progress: "In progress",
  blocked: "Blocked",
  review: "Needs review",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

const terminalStatuses = new Set<GroupTask["status"]>(["completed", "failed", "cancelled"]);

function participantLabel(participant?: CloudParticipant) {
  if (!participant) return "Unassigned";
  const kind = participant.kind === "human" ? "Human" : participant.kind.replace("_", " ");
  return participant.display_name + " · " + kind;
}

function latestByTask<T extends { task_id: string; created_at: string }>(items: T[]) {
  const latest = new Map<string, T>();
  for (const item of items) {
    const previous = latest.get(item.task_id);
    if (!previous || Date.parse(item.created_at) > Date.parse(previous.created_at)) latest.set(item.task_id, item);
  }
  return latest;
}

export default function GroupTaskBoard({
  roomId,
  participants,
  currentHumanParticipantId,
  isGroupOwner,
}: Props) {
  const [tasks, setTasks] = useState<GroupTask[]>([]);
  const [dependencies, setDependencies] = useState<GroupTaskDependency[]>([]);
  const [submissions, setSubmissions] = useState<GroupTaskSubmission[]>([]);
  const [reviews, setReviews] = useState<GroupTaskReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [busyTask, setBusyTask] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [expectedOutput, setExpectedOutput] = useState("");
  const [acceptanceCriteriaDraft, setAcceptanceCriteriaDraft] = useState("");
  const [createAttempt, setCreateAttempt] = useState<{ fingerprint: string; key: string } | null>(null);
  const [submissionAttempts, setSubmissionAttempts] = useState<Record<string, { fingerprint: string; key: string }>>({});
  const [assignedTo, setAssignedTo] = useState("");
  const [priority, setPriority] = useState("3");
  const [dueAt, setDueAt] = useState("");
  const [dependencyIds, setDependencyIds] = useState<string[]>([]);
  const [feedbackDrafts, setFeedbackDrafts] = useState<Record<string, string>>({});
  const [resultDrafts, setResultDrafts] = useState<Record<string, string>>({});
  const [assignmentDrafts, setAssignmentDrafts] = useState<Record<string, string>>({});

  async function refresh(shouldCommit: () => boolean = () => true) {
    const [nextTasks, nextDependencies, nextSubmissions, nextReviews] = await Promise.all([
      listGroupTasks(roomId),
      listGroupTaskDependencies(roomId),
      listGroupTaskSubmissions(roomId),
      listGroupTaskReviews(roomId),
    ]);
    if (!shouldCommit()) return;
    setTasks(nextTasks);
    setDependencies(nextDependencies);
    setSubmissions(nextSubmissions);
    setReviews(nextReviews);
  }

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        await refresh(() => active);
        if (active) setError("");
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : "Could not load group tasks.");
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    const unsubscribe = subscribeToGroupTasks(roomId, () => {
      void load();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [roomId]);

  const participantById = useMemo(
    () => new Map(participants.map((participant) => [participant.id, participant])),
    [participants],
  );
  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const submissionsByTask = useMemo(() => latestByTask(submissions), [submissions]);
  const latestReviews = useMemo(() => latestByTask(reviews), [reviews]);
  const counts = useMemo(() => ({
    open: tasks.filter((task) => !terminalStatuses.has(task.status)).length,
    review: tasks.filter((task) => task.status === "review").length,
    completed: tasks.filter((task) => task.status === "completed").length,
  }), [tasks]);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    if (!currentHumanParticipantId || !title.trim() || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const due = dueAt ? new Date(dueAt) : null;
      if (due && !Number.isFinite(due.getTime())) throw new Error("Choose a valid due date.");
      const acceptanceCriteria = acceptanceCriteriaDraft.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (acceptanceCriteria.length > 20 || acceptanceCriteria.some((line) => line.length > 500)) {
        throw new Error("Use at most 20 acceptance criteria, each no longer than 500 characters.");
      }
      const taskInput = {
        roomId,
        creatorParticipantId: currentHumanParticipantId,
        title: title.trim(),
        description: description.trim(),
        expectedOutput: expectedOutput.trim(),
        acceptanceCriteria,
        assignedToParticipantId: assignedTo || null,
        dependencyIds,
        priority: Number(priority),
        dueAt: due ? due.toISOString() : null,
      };
      const fingerprint = JSON.stringify(taskInput);
      const idempotencyKey = createAttempt?.fingerprint === fingerprint
        ? createAttempt.key
        : crypto.randomUUID();
      setCreateAttempt({ fingerprint, key: idempotencyKey });
      await createGroupTask({ ...taskInput, idempotencyKey });
      await refresh();
      setTitle("");
      setDescription("");
      setExpectedOutput("");
      setAcceptanceCriteriaDraft("");
      setCreateAttempt(null);
      setAssignedTo("");
      setPriority("3");
      setDueAt("");
      setDependencyIds([]);
      setNotice("Task created in the shared group workspace.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create this task.");
    } finally {
      setBusy(false);
    }
  }

  async function onAssign(task: GroupTask) {
    if (busyTask) return;
    setBusyTask(task.id);
    setError("");
    setNotice("");
    try {
      const next = Object.prototype.hasOwnProperty.call(assignmentDrafts, task.id)
        ? assignmentDrafts[task.id]
        : (task.assigned_to_participant_id || "");
      await assignGroupTask(roomId, task.id, next || null);
      setNotice("Task assignment updated.");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update task assignment.");
    } finally {
      setBusyTask("");
    }
  }

  async function onReview(task: GroupTask, outcome: "approved" | "revision_requested") {
    if (busyTask) return;
    setBusyTask(task.id);
    setError("");
    setNotice("");
    try {
      await reviewGroupTask(roomId, task.id, outcome, feedbackDrafts[task.id] || "");
      setNotice(outcome === "approved" ? "Deliverable approved; task completed." : "Revision requested; task returned to its assignee.");
      // Clear the retry payload only after the refreshed state is read. If the
      // refresh fails, retrying the same review is idempotent at the database.
      await refresh();
      setFeedbackDrafts((current) => ({ ...current, [task.id]: "" }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not review this task.");
    } finally {
      setBusyTask("");
    }
  }

  async function onCancel(task: GroupTask) {
    if (busyTask || !window.confirm("Cancel this task? Its current work will remain in the history, but it will not be assigned or woken again.")) return;
    setBusyTask(task.id);
    setError("");
    setNotice("");
    try {
      await cancelGroupTask(roomId, task.id);
      setNotice("Task cancelled.");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not cancel this task.");
    } finally {
      setBusyTask("");
    }
  }

  async function onStart(task: GroupTask) {
    if (busyTask) return;
    setBusyTask(task.id);
    setError("");
    setNotice("");
    try {
      await claimGroupTaskAsHuman(roomId, task.id, currentHumanParticipantId);
      setNotice("Task started. Submit the result here when it is ready for review.");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start this task.");
    } finally {
      setBusyTask("");
    }
  }

  async function onSubmitResult(task: GroupTask) {
    const result = (resultDrafts[task.id] || "").trim();
    if (!result || busyTask) return;
    setBusyTask(task.id);
    setError("");
    setNotice("");
    try {
      const fingerprint = JSON.stringify([task.id, result]);
      const previousAttempt = submissionAttempts[task.id];
      const submissionKey = previousAttempt?.fingerprint === fingerprint
        ? previousAttempt.key
        : crypto.randomUUID();
      setSubmissionAttempts((current) => ({ ...current, [task.id]: { fingerprint, key: submissionKey } }));
      await submitGroupTaskResultAsHuman(roomId, task.id, currentHumanParticipantId, result, submissionKey);
      setNotice("Result submitted for human review.");
      // Keep the same result/key pair until refreshed state confirms the
      // submission. Retrying after a network/refresh error returns the same row.
      await refresh();
      setSubmissionAttempts((current) => {
        const next = { ...current };
        delete next[task.id];
        return next;
      });
      setResultDrafts((current) => ({ ...current, [task.id]: "" }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not submit the task result.");
    } finally {
      setBusyTask("");
    }
  }

  const incompleteDependencyChoices = tasks.filter((task) =>
    task.status !== "completed" && task.status !== "cancelled" && task.status !== "failed"
  );

  return (
    <section className="rm-task-board" aria-label="Group task coordination">
      <div className="rm-task-board-heading">
        <div>
          <div className="rm-task-eyebrow"><ListChecks size={16}/> GROUP COORDINATION</div>
          <h3>Tasks and deliverables</h3>
          <p>Tasks are shared group records. AI assignments use the existing participant connection and Backroom task-wake permission.</p>
        </div>
        <button type="button" className="rm-task-secondary" onClick={() => { void refresh().catch((e) => setError(e instanceof Error ? e.message : "Could not refresh tasks.")); }} disabled={loading || busy}>
          <RefreshCw size={15}/> Refresh
        </button>
      </div>

      <div className="rm-task-summary" aria-live="polite">
        <span><strong>{counts.open}</strong> open</span>
        <span><strong>{counts.review}</strong> awaiting review</span>
        <span><strong>{counts.completed}</strong> completed</span>
      </div>

      {error && <p className="rm-task-error" role="alert"><AlertCircle size={15}/>{error}</p>}
      {notice && <p className="rm-task-notice" role="status"><Check size={15}/>{notice}</p>}

      <form className="rm-task-create" onSubmit={onCreate}>
        <div className="rm-task-form-heading"><Plus size={17}/><strong>Create a group task</strong></div>
        <label>
          Task title
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} required placeholder="What needs to be done?"/>
        </label>
        <label>
          Description
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={12000} placeholder="Context, requirements and useful links…"/>
        </label>
        <label>
          Expected output
          <textarea value={expectedOutput} onChange={(e) => setExpectedOutput(e.target.value)} rows={2} maxLength={4000} placeholder="What should the assignee deliver?"/>
        </label>
        <label>
          Acceptance criteria (one per line)
          <textarea value={acceptanceCriteriaDraft} onChange={(e) => setAcceptanceCriteriaDraft(e.target.value)} rows={3} maxLength={10000} placeholder={"Tests pass\nEvidence is attached\nHuman review is complete"}/>
        </label>
        <div className="rm-task-form-grid">
          <label>
            Assign to
            <select value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)}>
              <option value="">Leave unassigned</option>
              {participants.map((participant) => <option key={participant.id} value={participant.id}>{participantLabel(participant)}</option>)}
            </select>
          </label>
          <label>
            Priority
            <select value={priority} onChange={(e) => setPriority(e.target.value)}>
              <option value="1">1 · Highest</option>
              <option value="2">2 · High</option>
              <option value="3">3 · Normal</option>
              <option value="4">4 · Low</option>
              <option value="5">5 · Lowest</option>
            </select>
          </label>
          <label>
            Due date (optional)
            <input type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)}/>
          </label>
        </div>
        {incompleteDependencyChoices.length > 0 && <fieldset className="rm-task-dependencies">
          <legend>Prerequisites (optional)</legend>
          <div className="rm-task-dependency-options">
            {incompleteDependencyChoices.map((task) => (
              <label key={task.id}>
                <input
                  type="checkbox"
                  checked={dependencyIds.includes(task.id)}
                  onChange={(e) => setDependencyIds((current) =>
                    e.target.checked ? [...current, task.id].slice(0, 20) : current.filter((id) => id !== task.id)
                  )}
                />
                <span>{task.title}</span>
              </label>
            ))}
          </div>
          <small>Assigned tasks remain in backlog until every prerequisite is completed. Cycles are rejected by the database.</small>
        </fieldset>}
        <div className="rm-task-form-actions">
          <button className="rm-task-primary" type="submit" disabled={busy || !title.trim()}>
            <Plus size={16}/>{busy ? "Creating…" : "Create task"}
          </button>
        </div>
      </form>

      <div className="rm-task-list-heading"><strong>Group task board</strong><span>{tasks.length} tasks</span></div>
      {loading ? <p className="rm-task-empty">Loading group tasks…</p>
        : tasks.length === 0 ? <p className="rm-task-empty">No tasks yet. Create one above or ask a connected AI to propose a task through MCP.</p>
        : <div className="rm-task-list">
          {tasks.map((task) => {
            const creator = participantById.get(task.created_by_participant_id);
            const assignee = task.assigned_to_participant_id ? participantById.get(task.assigned_to_participant_id) : undefined;
            const taskDependencies = dependencies.filter((dependency) => dependency.task_id === task.id);
            const latestSubmission = submissionsByTask.get(task.id);
            const latestReview = latestReviews.get(task.id);
            const canManage = isGroupOwner || task.created_by_participant_id === currentHumanParticipantId;
            const isAssignedHuman = task.assigned_to_participant_id === currentHumanParticipantId;
            const hasPendingPrerequisites = taskDependencies.some((dependency) =>
              taskById.get(dependency.depends_on_task_id)?.status !== "completed"
            );
            const canStart = (task.status === "backlog" || task.status === "assigned") &&
              !hasPendingPrerequisites &&
              (!task.assigned_to_participant_id || task.assigned_to_participant_id === currentHumanParticipantId);
            const assignmentValue = Object.prototype.hasOwnProperty.call(assignmentDrafts, task.id)
              ? assignmentDrafts[task.id] : (task.assigned_to_participant_id || "");
            return (
              <article className="rm-task-card" key={task.id}>
                <div className="rm-task-card-top">
                  <div>
                    <span className={"rm-task-status rm-task-status-" + task.status}>{statusLabels[task.status]}</span>
                    <span className="rm-task-priority">Priority {task.priority}</span>
                  </div>
                  <time>{new Date(task.created_at).toLocaleDateString()}</time>
                </div>
                <h4>{task.title}</h4>
                {task.description && <p className="rm-task-description">{task.description}</p>}
                {task.expected_output && <p className="rm-task-expected"><strong>Expected:</strong> {task.expected_output}</p>}
                {task.acceptance_criteria.length > 0 && <ul className="rm-task-criteria">
                  {task.acceptance_criteria.map((criterion, index) => <li key={index}>{criterion}</li>)}
                </ul>}
                <div className="rm-task-meta">
                  <span><UserRound size={14}/> {participantLabel(assignee)}</span>
                  <span>Proposed by {creator?.display_name || "Participant"}</span>
                  {task.due_at && <span><Clock3 size={14}/> Due {new Date(task.due_at).toLocaleString()}</span>}
                </div>
                {taskDependencies.length > 0 && <div className="rm-task-prerequisites">
                  <strong>Prerequisites:</strong>
                  {taskDependencies.map((dependency) => {
                    const prerequisite = taskById.get(dependency.depends_on_task_id);
                    return <span key={dependency.id}>{prerequisite?.title || "Task"} · {prerequisite ? statusLabels[prerequisite.status] : "Unavailable"}</span>;
                  })}
                </div>}
                {task.blocked_reason && <p className="rm-task-blocked"><AlertCircle size={14}/>{task.blocked_reason}</p>}
                {latestSubmission && <div className="rm-task-submission">
                  <strong>Latest submitted result</strong>
                  <p>{latestSubmission.result_content}</p>
                  <small>{participantLabel(participantById.get(latestSubmission.submitted_by_participant_id))} · {new Date(latestSubmission.created_at).toLocaleString()}</small>
                </div>}
                {latestReview && <div className="rm-task-review-note">
                  <strong>Latest review: {latestReview.outcome === "approved" ? "Approved" : "Revision requested"}</strong>
                  {latestReview.feedback && <p>{latestReview.feedback}</p>}
                </div>}

                {canManage && ["backlog", "assigned", "blocked"].includes(task.status) && <div className="rm-task-assignment-control">
                  <label>
                    Change assignee
                    <select value={assignmentValue} onChange={(e) => setAssignmentDrafts((current) => ({ ...current, [task.id]: e.target.value }))}>
                      <option value="">Unassigned</option>
                      {participants.map((participant) => <option key={participant.id} value={participant.id}>{participantLabel(participant)}</option>)}
                    </select>
                  </label>
                  <button type="button" className="rm-task-secondary" disabled={busyTask === task.id || assignmentValue === (task.assigned_to_participant_id || "")} onClick={() => { void onAssign(task); }}>
                    {busyTask === task.id ? "Saving…" : "Save assignment"}
                  </button>
                </div>}

                {canManage && !terminalStatuses.has(task.status) && <button type="button" className="rm-task-secondary" disabled={busyTask === task.id} onClick={() => { void onCancel(task); }}>Cancel task</button>}
                {(isAssignedHuman || (!task.assigned_to_participant_id && canStart)) && canStart && <button type="button" className="rm-task-primary" disabled={busyTask === task.id} onClick={() => { void onStart(task); }}>
                  {busyTask === task.id ? "Starting…" : "Start task"}
                </button>}
                {task.status === "backlog" && hasPendingPrerequisites && (isAssignedHuman || (!task.assigned_to_participant_id && canManage)) &&
                  <p className="rm-task-empty">Waiting for prerequisite tasks to be completed.</p>}
                {isAssignedHuman && task.status === "in_progress" && <div className="rm-task-result-form">
                  <label>
                    Submit your result for review
                    <textarea rows={4} maxLength={20000} value={resultDrafts[task.id] || ""} onChange={(e) => setResultDrafts((current) => ({ ...current, [task.id]: e.target.value }))} placeholder="Write the deliverable, evidence or completion summary…"/>
                  </label>
                  <button type="button" className="rm-task-primary" disabled={busyTask === task.id || !(resultDrafts[task.id] || "").trim()} onClick={() => { void onSubmitResult(task); }}>
                    <Send size={15}/>{busyTask === task.id ? "Submitting…" : "Submit for review"}
                  </button>
                </div>}
                {task.status === "review" && canManage && <div className="rm-task-review-form">
                  <label>
                    Review feedback (optional)
                    <textarea rows={2} maxLength={12000} value={feedbackDrafts[task.id] || ""} onChange={(e) => setFeedbackDrafts((current) => ({ ...current, [task.id]: e.target.value }))} placeholder="Explain approval or what needs revision…"/>
                  </label>
                  <div>
                    <button type="button" className="rm-task-primary" disabled={busyTask === task.id} onClick={() => { void onReview(task, "approved"); }}>
                      <Check size={15}/>Approve
                    </button>
                    <button type="button" className="rm-task-secondary" disabled={busyTask === task.id} onClick={() => { void onReview(task, "revision_requested"); }}>
                      Request revision
                    </button>
                  </div>
                </div>}
              </article>
            );
          })}
        </div>}
    </section>
  );
}
