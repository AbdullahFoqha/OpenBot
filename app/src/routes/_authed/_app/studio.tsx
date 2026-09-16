import {
  IconChevronRight,
  IconPlayerPlay,
  IconPlayerStop,
  IconRefresh,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { PageEmpty, PageRows, PageSection, PageShell } from "@/components/layout/page-shell";
import { Separator } from "@/components/ui/separator";
import {
  continueStudioTaskMutationOptions,
  pauseStudioQueueMutationOptions,
  resumeStudioQueueMutationOptions,
  runCodingTestMutationOptions,
  runStudioTaskMutationOptions,
  selectStudioProjectMutationOptions,
  stopStudioTaskMutationOptions,
} from "@/lib/studio/mutations";
import {
  type StudioTask,
  studioProjectQueryOptions,
  studioSetupQueryOptions,
  studioTasksQueryOptions,
} from "@/lib/studio/queries";

export const Route = createFileRoute("/_authed/_app/studio")({
  component: StudioPage,
});

/** Online/Needs Login/Not Tested, in the vocabulary the setup kit asked for. */
function statusWord(value: string): string {
  switch (value) {
    case "online":
      return "Online";
    case "needs_login":
      return "Needs Login";
    case "not_tested":
      return "Not Tested";
    case "error":
      return "Error";
    default:
      return value;
  }
}

function StudioPage() {
  const queryClient = useQueryClient();
  const setup = useQuery(studioSetupQueryOptions());
  const project = useQuery(studioProjectQueryOptions());
  const hasActiveWork = (setup.data?.activeCount ?? 0) > 0;
  const tasks = useQuery(studioTasksQueryOptions(hasActiveWork));

  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [projectPathInput, setProjectPathInput] = useState("");
  const [projectError, setProjectError] = useState<string | null>(null);
  const selectProject = useMutation({
    ...selectStudioProjectMutationOptions(queryClient),
    onSuccess: () => {
      setProjectDialogOpen(false);
      setProjectError(null);
    },
    onError: (err: Error) => setProjectError(err.message),
  });

  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [acceptanceCriteria, setAcceptanceCriteria] = useState("");
  const [taskError, setTaskError] = useState<string | null>(null);
  const [lastSubmitKey, setLastSubmitKey] = useState<string | null>(null);
  const runTask = useMutation({
    ...runStudioTaskMutationOptions(queryClient),
    onSuccess: () => {
      setTitle("");
      setGoal("");
      setAcceptanceCriteria("");
      setTaskError(null);
    },
    onError: (err: Error) => setTaskError(err.message),
  });

  const [codingTestError, setCodingTestError] = useState<string | null>(null);
  const runCodingTest = useMutation({
    ...runCodingTestMutationOptions(queryClient),
    onError: (err: Error) => setCodingTestError(err.message),
    onSuccess: () => setCodingTestError(null),
  });

  const pauseQueue = useMutation(pauseStudioQueueMutationOptions(queryClient));
  const resumeQueue = useMutation(resumeStudioQueueMutationOptions(queryClient));
  const stopTask = useMutation(stopStudioTaskMutationOptions(queryClient));
  const continueTask = useMutation(continueStudioTaskMutationOptions(queryClient));

  /*
   * Clear Activity clears only what is on screen — a set of dismissed ids held in this component's
   * own state, never sent to the server. Durable rows are untouched; a refresh brings every one of
   * them back, which is the whole point: this is a filter, not a delete.
   */
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const visibleTasks = (tasks.data?.tasks ?? []).filter((task) => !dismissed.has(task.id));

  function submitTask() {
    if (!title.trim() || !goal.trim()) {
      setTaskError("A title and goal are required.");
      return;
    }
    const key = lastSubmitKey ?? `${Date.now()}-${Math.random()}`;
    setLastSubmitKey(key);
    runTask.mutate({ title, goal, acceptanceCriteria, idempotencyKey: key });
  }

  return (
    <PageShell
      description="One place to select the project, watch setup, and hand the team a bounded task."
      title="Studio"
    >
      <PageSection
        action={
          <Button
            onClick={() => setup.refetch()}
            size="sm"
            variant="ghost"
          >
            <IconRefresh />
            Check Setup
          </Button>
        }
        description="Inspecting services and configuration only — nothing here spends the model allowance."
        title="Setup status"
      >
        {setup.isPending ? null : setup.error ? (
          <p className="text-sm text-destructive" role="alert">
            Could not read setup status.
          </p>
        ) : (
          <PageRows>
            <Item size="sm">
              <ItemContent>
                <ItemTitle>Server</ItemTitle>
                <ItemDescription>The API this app talks to.</ItemDescription>
              </ItemContent>
              <ItemActions>{statusWord(setup.data?.server ?? "")}</ItemActions>
            </Item>
            <Separator />
            <Item size="sm">
              <ItemContent>
                <ItemTitle>Database</ItemTitle>
              </ItemContent>
              <ItemActions>{statusWord(setup.data?.database ?? "")}</ItemActions>
            </Item>
            <Separator />
            <Item size="sm">
              <ItemContent>
                <ItemTitle>Cursor CLI login</ItemTitle>
                <ItemDescription>What the worker will run coding tasks with.</ItemDescription>
              </ItemContent>
              <ItemActions>{statusWord(setup.data?.cursorLogin ?? "")}</ItemActions>
            </Item>
            <Separator />
            <Item
              render={<button onClick={() => setProjectDialogOpen(true)} type="button" />}
              size="sm"
            >
              <ItemContent>
                <ItemTitle>Project</ItemTitle>
                <ItemDescription className="line-clamp-none">
                  {project.data?.project?.path ?? "No project selected yet."}
                  {project.data?.project && !project.data.project.verified
                    ? ` — ${project.data.project.reason ?? "not verified"}`
                    : null}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <IconChevronRight className="size-4 text-muted-foreground" />
              </ItemActions>
            </Item>
            <Separator />
            <Item size="sm">
              <ItemContent>
                <ItemTitle>Queue</ItemTitle>
                <ItemDescription>
                  {setup.data?.queuePaused
                    ? "Paused. Already-running work continues; nothing new is assigned."
                    : `Assigning work. Up to ${setup.data?.policy.maxActiveExecutionTasks ?? 3} tasks run at once.`}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Switch
                  checked={!setup.data?.queuePaused}
                  onCheckedChange={(checked) =>
                    checked ? resumeQueue.mutate() : pauseQueue.mutate()
                  }
                />
              </ItemActions>
            </Item>
          </PageRows>
        )}
        {setup.data?.nextAction ? (
          <p className="mt-3 text-sm text-muted-foreground">{setup.data.nextAction}</p>
        ) : null}
      </PageSection>

      <PageSection
        description="Runs a real, disposable fixture through the same worker and admission path a task uses, and independently re-checks what it produced. Uses the selected coding model's allowance."
        title="Coding test"
      >
        <Button
          disabled={runCodingTest.isPending}
          onClick={() => runCodingTest.mutate()}
        >
          <IconPlayerPlay />
          {runCodingTest.isPending ? "Starting…" : "Run Coding Test"}
        </Button>
        {codingTestError ? (
          <p className="mt-2 text-sm text-destructive" role="alert">
            {codingTestError}
          </p>
        ) : null}
        {runCodingTest.data ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Dispatched as task {runCodingTest.data.taskId} on {runCodingTest.data.model}. Watch it
            in Active work below.
          </p>
        ) : null}
      </PageSection>

      <PageSection description="A bounded assignment for the team's Engineer." title="Run a task">
        <div className="flex flex-col gap-3">
          <Input
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title"
            value={title}
          />
          <Textarea
            onChange={(e) => setGoal(e.target.value)}
            placeholder="Goal — what should change"
            value={goal}
          />
          <Textarea
            onChange={(e) => setAcceptanceCriteria(e.target.value)}
            placeholder="Acceptance criteria — what makes this done"
            value={acceptanceCriteria}
          />
          <div>
            <Button
              disabled={runTask.isPending || !project.data?.project?.verified}
              onClick={submitTask}
            >
              <IconPlayerPlay />
              {runTask.isPending ? "Submitting…" : "Run Task"}
            </Button>
          </div>
          {!project.data?.project?.verified ? (
            <p className="text-sm text-muted-foreground">Select a verified project above first.</p>
          ) : null}
          {taskError ? (
            <p className="text-sm text-destructive" role="alert">
              {taskError}
            </p>
          ) : null}
        </div>
      </PageSection>

      <PageSection
        action={
          <Button onClick={() => setDismissed(new Set(visibleTasks.map((t) => t.id)))} size="sm" variant="ghost">
            Clear activity
          </Button>
        }
        description="Owner, progress, and the evidence behind each result."
        title="Active work"
      >
        {tasks.isPending ? null : tasks.error ? (
          <p className="text-sm text-destructive" role="alert">
            Could not load studio tasks.
          </p>
        ) : visibleTasks.length === 0 ? (
          <PageEmpty>Nothing here yet. Run a task or the coding test above.</PageEmpty>
        ) : (
          <PageRows>
            {visibleTasks.map((task, index) => (
              <div key={task.id}>
                <TaskRow
                  onContinue={() => continueTask.mutate(task.id)}
                  onStop={() => stopTask.mutate(task.id)}
                  task={task}
                />
                {index !== visibleTasks.length - 1 ? <Separator /> : null}
              </div>
            ))}
          </PageRows>
        )}
      </PageSection>

      <Dialog onOpenChange={setProjectDialogOpen} open={projectDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Select project</DialogTitle>
          </DialogHeader>
          <DialogBody className="mt-4">
            <p className="text-sm text-muted-foreground">
              An absolute path to a local git checkout. Resolved and verified on this machine before
              it is saved — a browser cannot hand a script a real filesystem path, so this is a
              pasted path rather than a native folder picker; that picker would need the desktop
              shell, not this web screen.
            </p>
            <Input
              className="mt-3"
              onChange={(e) => setProjectPathInput(e.target.value)}
              placeholder="/Users/you/Documents/projects/your-project"
              value={projectPathInput}
            />
            {projectError ? (
              <p className="mt-2 text-sm text-destructive" role="alert">
                {projectError}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button
              disabled={selectProject.isPending}
              onClick={() => selectProject.mutate(projectPathInput.trim())}
            >
              {selectProject.isPending ? "Verifying…" : "Verify and select"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}

function TaskRow({
  task,
  onStop,
  onContinue,
}: {
  task: StudioTask;
  onStop: () => void;
  onContinue: () => void;
}) {
  const ok = task.evidence?.ok;
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        <IconPlayerPlay />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{task.title}</ItemTitle>
        <ItemDescription className="line-clamp-none">
          {task.state.replace(/_/g, " ")}
          {task.ownerBotId ? ` · ${task.ownerBotId}` : ""}
          {task.running ? " · running" : ""}
          {task.blockedReason ? ` · ${task.blockedReason}` : ""}
          {task.evidence
            ? ok
              ? ` · verified: ${task.evidence.changedFiles.length} file(s) changed`
              : ` · not verified: ${task.evidence.blocker ?? "unknown"}`
            : ""}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        {task.running ? (
          <Button onClick={onStop} size="sm" variant="outline">
            <IconPlayerStop />
            Stop
          </Button>
        ) : task.state === "in_progress" ? (
          <Button onClick={onContinue} size="sm" variant="outline">
            Continue
          </Button>
        ) : null}
      </ItemActions>
    </Item>
  );
}
