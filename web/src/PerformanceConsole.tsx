import { useRef, useState } from 'react';
import {
  ApiError,
  loadPerformance,
  newRequestId,
  submitPerformanceCommand,
  type Performance,
  type PerformanceStatus,
} from './api';

class ClientError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

interface ConsoleError {
  code: string;
  reason?: string;
  message: string;
}

const STATUS_LABELS: Record<PerformanceStatus, string> = {
  pending: '待演',
  running: '运行中',
  paused: '已暂停',
  ended: '已结束',
};

function parseInt32(text: string): number {
  const t = text.trim();
  if (t === '') throw new ClientError('INVALID_CUE', '请输入整数 cue。');
  const n = Number(t);
  if (!Number.isInteger(n)) throw new ClientError('INVALID_CUE', 'cue 必须是整数。');
  if (n < -2147483648 || n > 2147483647) {
    throw new ClientError('INVALID_CUE', 'cue 必须是 32 位有符号整数。');
  }
  return n;
}

export default function PerformanceConsole() {
  const [session, setSession] = useState<Performance | null>(null);
  const [error, setError] = useState<ConsoleError | null>(null);
  const [commandBusy, setCommandBusy] = useState(false);
  const [loadBusy, setLoadBusy] = useState(false);
  const [name, setName] = useState('');
  const [loadId, setLoadId] = useState('');
  // The cue draft belongs to the session it was typed for: keep one draft per
  // performance id so switching the displayed session (e.g. a load while a
  // command is in flight) never leaks one session's uncommitted cue into
  // another session's input.
  const [cueDrafts, setCueDrafts] = useState<Record<string, string>>({});
  const cueText = session ? (cueDrafts[session.id] ?? '') : '';

  function setCueTextFor(performanceId: string, text: string) {
    setCueDrafts((drafts) => ({ ...drafts, [performanceId]: text }));
  }

  // Monotonic token of the last user-initiated request. Responses that were
  // superseded by a later action must never touch the view: otherwise a slow
  // load of session B could be overwritten by an even slower response for A,
  // or a stale GET snapshot could roll a freshly committed version backwards.
  const generationRef = useRef(0);
  const sessionRef = useRef<Performance | null>(null);
  const commandInFlightRef = useRef(0);
  const loadInFlightRef = useRef(0);

  function reportError(err: unknown): ConsoleError {
    if (err instanceof ApiError) {
      return { code: err.code, reason: err.reason, message: err.message };
    }
    if (err instanceof ClientError) {
      return { code: err.code, message: err.message };
    }
    return { code: 'NETWORK', message: '无法连接服务，请确认 API 已启动。' };
  }

  /**
   * Merge an arriving snapshot with the one on screen. Loads and commands may
   * be in flight at the same time and may finish in any order. A response
   * belonging to the latest user action may switch the displayed session, but
   * a GET must never downgrade a version a command already committed. A
   * response superseded by a newer action may only catch the same session up
   * in version — it can never switch sessions or surface a stale error.
   *
   * Returns true only when the snapshot was applied to the session currently
   * on screen; callers use this to gate follow-ups that belong to that
   * session (such as clearing its cue draft).
   */
  function adoptSnapshot(next: Performance, stale: boolean): boolean {
    const current = sessionRef.current;
    if (stale) {
      if (!current || current.id !== next.id || next.version <= current.version) {
        return false;
      }
    } else if (current && current.id === next.id && current.version > next.version) {
      return false;
    }
    sessionRef.current = next;
    setSession(next);
    return true;
  }

  /**
   * Run one command. `onCommitted` runs only after the server has accepted
   * the write (the returned snapshot is the committed one). Because the
   * console is never unmounted by a tab switch, in-flight commands finish
   * here regardless of which entry is visible.
   */
  function runCommand(
    action: () => Promise<Performance>,
    onCommitted?: (snapshot: Performance) => void,
  ) {
    const gen = ++generationRef.current;
    commandInFlightRef.current += 1;
    setCommandBusy(true);
    setError(null);
    void action().then(
      (snapshot) => {
        const adopted = adoptSnapshot(snapshot, generationRef.current !== gen);
        // Follow-ups belong to the command's session; if the view has since
        // moved to another session they must not touch the new session.
        if (adopted) onCommitted?.(snapshot);
      },
      (err) => {
        if (generationRef.current !== gen) return;
        // A rejected command changes nothing server-side: keep the snapshot.
        setError(reportError(err));
      },
    ).finally(() => {
      commandInFlightRef.current -= 1;
      if (commandInFlightRef.current === 0) setCommandBusy(false);
    });
  }

  // The only write entry: build a command envelope from the current snapshot.
  function dispatch(
    command: Parameters<typeof submitPerformanceCommand>[0],
    onCommitted?: (snapshot: Performance) => void,
  ) {
    runCommand(() => submitPerformanceCommand(command), onCommitted);
  }

  function onCreate() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError({ code: 'INVALID_BODY', message: '请填写场次名称。' });
      return;
    }
    void dispatch({ command: 'create', name: trimmed, requestId: newRequestId() });
  }

  function onLoad() {
    const id = loadId.trim();
    if (!id) {
      setError({ code: 'INVALID_BODY', message: '请输入要载入的场次 ID。' });
      return;
    }
    const gen = ++generationRef.current;
    loadInFlightRef.current += 1;
    setLoadBusy(true);
    setError(null);
    void loadPerformance(id).then(
      (snapshot) => {
        adoptSnapshot(snapshot, generationRef.current !== gen);
      },
      (err) => {
        if (generationRef.current !== gen) return;
        // A failed load (e.g. unknown id) must not wipe the session on screen;
        // the stage manager keeps the previous snapshot for comparison.
        setError(reportError(err));
      },
    ).finally(() => {
      loadInFlightRef.current -= 1;
      if (loadInFlightRef.current === 0) setLoadBusy(false);
    });
  }

  function transition(status: PerformanceStatus) {
    if (!session) return;
    void dispatch({
      command: 'transition',
      performanceId: session.id,
      status,
      expectedVersion: session.version,
      requestId: newRequestId(),
    });
  }

  function onRegisterCue() {
    if (!session) return;
    let cue: number;
    try {
      cue = parseInt32(cueText);
    } catch (err) {
      setError(reportError(err));
      return;
    }
    // Keep the draft while the command is in flight: the request may still
    // commit on the server even if the tab is switched before the response
    // arrives, and a rejection (e.g. VERSION_CONFLICT) leaves the cue
    // unregistered and must be retryable. Only clear once the server has
    // confirmed the commit — and only the draft of the session the command
    // actually belonged to.
    const performanceId = session.id;
    void dispatch(
      {
        command: 'registerCue',
        performanceId,
        cue,
        expectedVersion: session.version,
        requestId: newRequestId(),
      },
      (committed) => {
        if (committed.id === performanceId) {
          setCueDrafts((drafts) => {
            const next = { ...drafts };
            delete next[performanceId];
            return next;
          });
        }
      },
    );
  }

  return (
    <section className="console">
      <div className="console-entry">
        <label className="field">
          <span>创建场次（舞台监督）</span>
          <span className="field-row">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="场次名称，例如：9 月 17 日晚场"
              disabled={commandBusy}
              data-testid="create-name"
            />
            <button onClick={onCreate} disabled={commandBusy} data-testid="create-button">
              创建
            </button>
          </span>
        </label>
        <label className="field">
          <span>按 ID 载入快照</span>
          <span className="field-row">
            <input
              type="text"
              value={loadId}
              onChange={(e) => setLoadId(e.target.value)}
              placeholder="场次 ID（UUID）"
              disabled={loadBusy}
              spellCheck={false}
              data-testid="load-id"
            />
            <button className="secondary" onClick={onLoad} disabled={loadBusy} data-testid="load-button">
              载入
            </button>
          </span>
        </label>
      </div>

      {error && (
        <div className="verdict error console-error" role="alert" data-testid="console-error">
          <strong>
            <code>{error.code}</code>
            {error.reason ? (
              <>
                {' '}
                / <code>{error.reason}</code>
              </>
            ) : null}
          </strong>
          <span>{error.message}</span>
          <span className="error-hint">当前场次保留在页面上，数据未被改动。</span>
        </div>
      )}

      {!session && (
        <p className="console-empty" data-testid="console-empty">
          尚未打开场次：创建一场新演出，或按 ID 载入已有场次。
        </p>
      )}

      {session && (
        <article className="session" data-testid="session-card">
          <header className="session-head">
            <div>
              <h2 data-testid="session-name">{session.name}</h2>
              <p className="session-id" title={session.id}>
                ID：<code data-testid="session-id">{session.id}</code>
              </p>
            </div>
            <span className={`badge badge-${session.status}`} data-testid="session-status">
              {STATUS_LABELS[session.status]}
            </span>
          </header>

          <dl className="facts">
            <div>
              <dt>版本</dt>
              <dd data-testid="session-version">{session.version}</dd>
            </div>
            <div>
              <dt>已登记 cue</dt>
              <dd data-testid="cue-count">{session.cues.length}</dd>
            </div>
            <div className="fact-wide">
              <dt>最近提交请求标识</dt>
              <dd>
                <code data-testid="session-request-id">{session.requestId ?? '—'}</code>
              </dd>
            </div>
          </dl>

          {session.status === 'pending' && (
            <div className="actions">
              <button
                onClick={() => transition('running')}
                disabled={commandBusy}
                data-testid="start-button"
              >
                开演（待演 → 运行）
              </button>
            </div>
          )}

          {session.status === 'running' && (
            <>
              <div className="actions">
                <button
                  className="secondary"
                  onClick={() => transition('paused')}
                  disabled={commandBusy}
                  data-testid="pause-button"
                >
                  暂停
                </button>
                <button
                  className="danger"
                  onClick={() => transition('ended')}
                  disabled={commandBusy}
                  data-testid="end-button"
                >
                  结束
                </button>
              </div>
              <div className="cue-entry">
                <label className="field">
                  <span>逐条登记整数 cue（仅运行态可写入）</span>
                  <span className="field-row">
                    <input
                      type="number"
                      step={1}
                      value={cueText}
                      onChange={(e) => setCueTextFor(session.id, e.target.value)}
                      placeholder="整数 cue，如 101"
                      disabled={commandBusy}
                      data-testid="cue-input"
                    />
                    <button
                      onClick={onRegisterCue}
                      disabled={commandBusy}
                      data-testid="cue-register"
                    >
                      登记
                    </button>
                  </span>
                </label>
              </div>
            </>
          )}

          {session.status === 'paused' && (
            <div className="actions">
              <button
                onClick={() => transition('running')}
                disabled={commandBusy}
                data-testid="resume-button"
              >
                继续（→ 运行）
              </button>
              <button
                className="danger"
                onClick={() => transition('ended')}
                disabled={commandBusy}
                data-testid="end-button"
              >
                结束
              </button>
            </div>
          )}

          <Timeline session={session} />
        </article>
      )}
    </section>
  );
}

function Timeline({ session }: { session: Performance }) {
  const sealed = session.status === 'ended';
  return (
    <div className={`timeline${sealed ? ' sealed' : ''}`}>
      <h3>
        {sealed ? '封存时间线（只读）' : '现场时间线'}
        <span className="timeline-count">{session.cues.length} 条</span>
      </h3>
      {session.cues.length === 0 ? (
        <p className="timeline-empty">暂无 cue。</p>
      ) : (
        <ol className="cue-list">
          {session.cues.map((cue, i) => (
            <li key={i}>
              <span className="cue-index">#{i + 1}</span>
              <span className="cue-value">{cue}</span>
            </li>
          ))}
        </ol>
      )}
      {sealed && <p className="sealed-note">场次已结束，时间线封存，不再接受写入。</p>}
    </div>
  );
}
