export type ProgressStage =
  | "planning"
  | "creating_project"
  | "coding"
  | "testing"
  | "waiting_for_approval"
  | "completed";

export const PROGRESS_ORDER: Record<ProgressStage, number> = {
  planning: 0,
  creating_project: 1,
  coding: 2,
  testing: 3,
  waiting_for_approval: 4,
  completed: 5,
};

interface ProgressState {
  progress: ProgressStage;
  writeCount: number;
}

interface ProgressDecision {
  stage?: ProgressStage;
  message?: string;
  writeCount: number;
}

const TEST_PATTERN =
  /\bnode\s+--test\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|build|lint|typecheck)\b|\bpytest\b|\bvitest\b|\bjest\b|\btsc\b|\beslint\b|\bruff\b|\bmypy\b|\bcargo\s+test\b|\bgo\s+test\b/i;

const TEST_TODO_PATTERN =
  /\b(test|tests|testing|verify|verification|build|lint|type[- ]?check|check)\b/i;

const CREATE_PATTERN =
  /\bcreate-next-app\b|\bnpm\s+init\b|\bpnpm\s+create\b|\byarn\s+create\b|\bbun\s+create\b|\bmkdir\b|package\.json/i;

function isShellTool(name: string) {
  return (
    name.includes("bash") ||
    name.includes("shell") ||
    name.includes("execute") ||
    name.includes("terminal")
  );
}

function isWriteTool(name: string) {
  return (
    name.includes("write") ||
    name.includes("edit")
  );
}

function isTodoTool(name: string) {
  return (
    name.includes("todo")
  );
}

export function inferProgress(
  event: any,
  state: ProgressState
): ProgressDecision {
  let writeCount = state.writeCount;

  /*
   * A new Backboard session starts in planning.
   */
  if (
    event?.type === "session:created" ||
    event?.type === "turn:start"
  ) {
    return {
      stage: "planning",
      message: "Understanding your request",
      writeCount,
    };
  }

  /*
   * We currently infer progress primarily from
   * Backboard tool requests.
   */
  if (event?.type !== "tool:requested") {
    return {
      writeCount,
    };
  }

  const calls =
    event?.payload?.calls;

  if (!Array.isArray(calls)) {
    return {
      writeCount,
    };
  }

  for (const call of calls) {
    const name =
      String(
        call?.name ?? ""
      ).toLowerCase();

    const input =
      call?.input ?? {};

    const inputText =
      JSON.stringify(input);

    /*
     * Backboard's todo_write is a useful semantic signal.
     *
     * Example:
     *
     * {
     *   content: "Run tests and verify success",
     *   status: "in_progress"
     * }
     *
     * That means the agent has entered its testing phase.
     */
    if (isTodoTool(name)) {
      const todos =
        Array.isArray(input?.todos)
          ? input.todos
          : [];

      const activeTestingTodo =
        todos.find((todo: any) => {
          const content =
            String(
              todo?.content ?? ""
            );

          return (
            todo?.status === "in_progress" &&
            TEST_TODO_PATTERN.test(content)
          );
        });

      if (activeTestingTodo) {
        return {
          stage: "testing",
          message: "Testing the project",
          writeCount,
        };
      }
    }

    /*
     * Actual test/build/check command.
     *
     * Examples:
     * npm test
     * node --test
     * npm run build
     * pytest
     * tsc
     */
    if (
      isShellTool(name) &&
      TEST_PATTERN.test(inputText)
    ) {
      return {
        stage: "testing",
        message: "Running checks",
        writeCount,
      };
    }

    /*
     * Project scaffolding.
     */
    if (
      isShellTool(name) &&
      CREATE_PATTERN.test(inputText)
    ) {
      return {
        stage: "creating_project",
        message: "Creating the project",
        writeCount,
      };
    }

    /*
     * First write = initial project creation.
     *
     * Further writes/edits = coding.
     */
    if (isWriteTool(name)) {
      writeCount += 1;

      if (writeCount === 1) {
        return {
          stage: "creating_project",
          message: "Creating project files",
          writeCount,
        };
      }

      return {
        stage: "coding",
        message: "Writing code",
        writeCount,
      };
    }

    /*
     * Other shell activity after planning normally
     * represents implementation work.
     */
    if (
      isShellTool(name) &&
      state.progress !== "planning"
    ) {
      return {
        stage: "coding",
        message: "Working on the implementation",
        writeCount,
      };
    }
  }

  return {
    writeCount,
  };
}
