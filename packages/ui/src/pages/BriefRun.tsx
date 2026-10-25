import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import {
  buildFormModel,
  collectParams,
  FEDERATED_AGENTS,
  type FormModel,
  type FormValues,
  SINCE_PRESETS,
} from "../briefs/brief-form";
import { isPastDeadline } from "../briefs/brief-runs";
import { DESKTOP_EXCLUDED_AGENTS } from "../briefs/pack-sections";
import { CopyMarkdownButton } from "../components/briefs/CopyMarkdownButton";
import { PageHeader } from "../components/chrome/PageHeader";
import { Markdown } from "../components/markdown/Markdown";
import { useBriefRuns } from "../hooks/useBriefRuns";
import { useRolePacks } from "../hooks/useRolePacks";
import type { CatalogAgent, CatalogParam } from "../ipc/types";

const CLI_COMMAND: Readonly<Record<string, string>> = {
  premortem: "nimbus pre-mortem",
  preflight: "nimbus preflight",
};

const INPUT_CLASS =
  "border border-[var(--color-border)] rounded px-2 py-1 bg-[var(--color-surface)] text-sm";

function BackLink(): ReactNode {
  return (
    <Link to="/briefs" className="text-sm">
      ← Briefs
    </Link>
  );
}

function Shell({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <>
      <PageHeader title="Brief" />
      <div className="p-6 space-y-3">
        <BackLink />
        {children}
      </div>
    </>
  );
}

export function BriefRun(): ReactNode {
  const { agent = "" } = useParams();
  const { catalog, catalogError } = useRolePacks();

  if (DESKTOP_EXCLUDED_AGENTS.has(agent)) {
    const cmd = CLI_COMMAND[agent] ?? `nimbus ${agent}`;
    return (
      <Shell>
        <p className="text-sm">{`This brief is not available here. Run it from a terminal with "${cmd}".`}</p>
      </Shell>
    );
  }
  if (catalog === null) {
    return (
      <Shell>
        {catalogError === null ? (
          <p className="text-sm">Loading…</p>
        ) : (
          <p role="alert" className="text-sm text-[var(--color-error)]">
            {`Could not load the brief list: ${catalogError}`}
          </p>
        )}
      </Shell>
    );
  }
  const found = catalog.agents.find((a) => a.name === agent);
  if (found === undefined) {
    return (
      <Shell>
        <p className="text-sm">{`"${agent}" is not a built-in brief.`}</p>
      </Shell>
    );
  }
  // Keyed so a navigation between agents never carries one agent's form or run state to another.
  return <BriefRunView key={found.name} agent={found} />;
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function BriefRunView({ agent }: { readonly agent: CatalogAgent }): ReactNode {
  const runs = useBriefRuns();
  const model = buildFormModel(agent.params);
  const [values, setValues] = useState<FormValues>({});
  const [arms, setArms] = useState<Readonly<Record<string, string>>>({});
  const [problems, setProblems] = useState<readonly string[]>([]);
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  const [now, setNow] = useState(() => Date.now());

  const run = runs.latest(agent.name);
  const pending = run?.status === "pending";

  useEffect(() => {
    if (!pending) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [pending]);

  const onRun = async (): Promise<void> => {
    if (startingRef.current) return;
    const collected = collectParams(model, values, arms);
    if (!collected.ok) {
      setProblems(collected.problems);
      return;
    }
    setProblems([]);
    setStartError(null);
    startingRef.current = true;
    setStarting(true);
    try {
      await runs.start(agent.name, collected.params);
    } catch (e) {
      setStartError(e instanceof Error ? e.message : String(e));
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  };

  const setValue = (name: string, v: string | boolean): void =>
    setValues((prev) => ({ ...prev, [name]: v }));

  return (
    <>
      <PageHeader title={agent.displayName} />
      <div className="p-6 space-y-4">
        <BackLink />
        <p className="text-sm text-[var(--color-fg-muted)]">{agent.description}</p>
        {FEDERATED_AGENTS.has(agent.name) && <p className="text-sm">Asks your paired peers.</p>}
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            onRun().catch(() => undefined);
          }}
        >
          <Fields
            model={model}
            values={values}
            arms={arms}
            setValue={setValue}
            setArm={(group, arm) => setArms((prev) => ({ ...prev, [group]: arm }))}
          />
          {problems.length > 0 && (
            <ul role="alert" className="text-sm text-[var(--color-error)]">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={starting || (run?.status === "pending" && !isPastDeadline(run, now))}
              className="px-3 py-1 text-sm border border-[var(--color-border)] rounded disabled:opacity-50"
            >
              Run
            </button>
            {startError !== null && (
              <span role="alert" className="text-sm text-[var(--color-error)]">
                {startError}
              </span>
            )}
          </div>
        </form>
        {run?.status === "pending" && (
          <p className="text-sm" aria-live="polite">
            {isPastDeadline(run, now)
              ? "Still running — check back."
              : `Running… ${formatElapsed(now - run.requestedAt)}`}
          </p>
        )}
        {run?.status === "error" && (
          <p role="alert" className="text-sm text-[var(--color-error)]">
            {run.message}
          </p>
        )}
        {run?.status === "ready" && (
          <div className="space-y-2">
            <CopyMarkdownButton text={run.markdown} />
            <Markdown text={run.markdown} />
          </div>
        )}
      </div>
    </>
  );
}

function Fields(props: {
  readonly model: FormModel;
  readonly values: FormValues;
  readonly arms: Readonly<Record<string, string>>;
  readonly setValue: (name: string, v: string | boolean) => void;
  readonly setArm: (group: string, arm: string) => void;
}): ReactNode {
  const { model, values, arms, setValue, setArm } = props;
  return (
    <>
      {model.plain.map((p) => (
        <Field key={p.name} param={p} values={values} setValue={setValue} />
      ))}
      {model.groups.map((g) => {
        const chosen = g.arms.find((a) => a.arm === arms[g.group]);
        return (
          <fieldset key={g.group} className="space-y-2">
            <legend className="text-sm font-medium">
              {g.required ? `${g.group} (choose one)` : `${g.group} (optional)`}
            </legend>
            <div className="flex gap-2">
              {!g.required && (
                <button
                  type="button"
                  aria-pressed={chosen === undefined}
                  className={`px-2 py-1 text-sm border border-[var(--color-border)] rounded ${
                    chosen === undefined ? "bg-[var(--color-surface)]" : ""
                  }`}
                  onClick={() => setArm(g.group, "")}
                >
                  None
                </button>
              )}
              {g.arms.map((a) => (
                <button
                  key={a.arm}
                  type="button"
                  aria-pressed={chosen?.arm === a.arm}
                  className={`px-2 py-1 text-sm border border-[var(--color-border)] rounded ${
                    chosen?.arm === a.arm ? "bg-[var(--color-surface)]" : ""
                  }`}
                  onClick={() => setArm(g.group, a.arm)}
                >
                  {a.arm}
                </button>
              ))}
            </div>
            {chosen?.fields.map((f) => (
              <Field key={f.name} param={f} values={values} setValue={setValue} />
            ))}
          </fieldset>
        );
      })}
    </>
  );
}

function Field(props: {
  readonly param: CatalogParam;
  readonly values: FormValues;
  readonly setValue: (name: string, v: string | boolean) => void;
}): ReactNode {
  const { param, values, setValue } = props;
  const id = `brief-field-${param.name}`;
  const raw = values[param.name];
  const text = typeof raw === "string" ? raw : "";
  const required = param.required || param.oneOf?.armRequired === true;
  const baseLabel = param.name === "sinceMs" ? "Since" : param.label;
  const label = required ? `${baseLabel} *` : baseLabel;

  let widget: ReactNode;
  if (param.kind === "boolean") {
    widget = (
      <input
        id={id}
        type="checkbox"
        checked={raw === true}
        onChange={(e) => setValue(param.name, e.target.checked)}
      />
    );
  } else if (param.name === "sinceMs") {
    widget = (
      <select
        id={id}
        className={INPUT_CLASS}
        value={text === "" ? "Default" : text}
        onChange={(e) => setValue(param.name, e.target.value)}
      >
        {SINCE_PRESETS.map((s) => (
          <option key={s.label} value={s.ms === undefined ? "Default" : String(s.ms)}>
            {s.label}
          </option>
        ))}
      </select>
    );
  } else {
    widget = (
      <input
        id={id}
        type={param.kind === "number" ? "number" : "text"}
        className={INPUT_CLASS}
        placeholder={param.kind === "stringArray" ? "comma, separated" : undefined}
        value={text}
        onChange={(e) => setValue(param.name, e.target.value)}
      />
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm">
        {label}
      </label>
      {widget}
    </div>
  );
}
