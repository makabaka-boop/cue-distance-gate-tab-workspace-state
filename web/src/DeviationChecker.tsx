import { useRef, useState } from 'react';
import { ApiError, fetchDistance, type DistanceResponse } from './api';

const SAMPLE_PLAN = '[101, 102, 103, 104, 105, 106, 107, 108]';
const SAMPLE_LIVE = '[101, 102, 104, 105, 205, 106, 107]';

class ClientError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

interface Outcome {
  kind: 'result' | 'error';
  // Identity of the comparison that produced this verdict. The checker stays
  // mounted across tab switches, so an older comparison may resolve after a
  // newer one; only the latest comparison is allowed to surface its verdict.
  seq: number;
  value?: DistanceResponse;
  code?: string;
  message?: string;
}

function parseJsonArray(text: string, label: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ClientError(
      'INVALID_JSON',
      `${label}不是合法的 JSON，请输入标准 JSON 数组（例如 [1, 2, 3]）。`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new ClientError('INVALID_BODY', `${label}必须是 JSON 数组。`);
  }
  return parsed;
}

function parseK(text: string): number {
  const k = Number(text);
  if (text.trim() === '' || !Number.isInteger(k) || k < 0 || k > 500) {
    throw new ClientError('INVALID_K', '阈值 K 必须是 0 到 500 之间的整数。');
  }
  return k;
}

/** Independent entry 2: planned-vs-live cue sequence deviation checker. */
export default function DeviationChecker() {
  const [planText, setPlanText] = useState(SAMPLE_PLAN);
  const [liveText, setLiveText] = useState(SAMPLE_LIVE);
  const [kText, setKText] = useState('3');
  const [inFlight, setInFlight] = useState(0);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  // Identity of the latest comparison. This entry is never unmounted when the
  // user switches to the console tab and back, so a request already on the
  // wire keeps its identity and still settles here; when comparisons overlap
  // (including one started while another is still in flight), a stale
  // response can never overwrite the freshest conclusion.
  const seqRef = useRef(0);

  async function onCompare() {
    const seq = ++seqRef.current;
    setInFlight((n) => n + 1);
    // A new comparison supersedes any verdict currently shown, but the
    // inputs of both the prior and the new comparison are preserved.
    setOutcome(null);
    try {
      const a = parseJsonArray(planText, '计划 cue 序列');
      const b = parseJsonArray(liveText, '现场触发序列');
      const k = parseK(kText);
      const value = await fetchDistance(a, b, k);
      if (seqRef.current !== seq) return;
      setOutcome({ kind: 'result', seq, value });
    } catch (err) {
      if (seqRef.current !== seq) return;
      if (err instanceof ClientError || err instanceof ApiError) {
        setOutcome({ kind: 'error', seq, code: err.code, message: err.message });
      } else {
        setOutcome({
          kind: 'error',
          seq,
          code: 'NETWORK',
          message: '无法连接校验服务，请确认 API 已启动。',
        });
      }
    } finally {
      setInFlight((n) => n - 1);
    }
  }

  const busy = inFlight > 0;

  return (
    <section>
      <section className="editors">
        <label className="editor">
          <span>计划 cue 序列（JSON 整数数组，≤ 50000 项）</span>
          <textarea
            value={planText}
            onChange={(e) => setPlanText(e.target.value)}
            spellCheck={false}
            rows={10}
            placeholder="[101, 102, 103]"
            data-testid="plan-input"
          />
        </label>
        <label className="editor">
          <span>现场触发序列（JSON 整数数组，≤ 50000 项）</span>
          <textarea
            value={liveText}
            onChange={(e) => setLiveText(e.target.value)}
            spellCheck={false}
            rows={10}
            placeholder="[101, 102, 104]"
            data-testid="live-input"
          />
        </label>
      </section>

      <section className="controls">
        <label className="threshold">
          阈值 K（0–500）
          <input
            type="number"
            min={0}
            max={500}
            step={1}
            value={kText}
            onChange={(e) => setKText(e.target.value)}
            data-testid="k-input"
          />
        </label>
        <button onClick={onCompare} data-testid="compare-button">
          {busy ? `校验中…（在途 ${inFlight}）` : '比较'}
        </button>
      </section>

      {outcome?.kind === 'error' && (
        <section className="verdict error" role="alert" data-testid="deviation-error">
          <h2>❌ 输入无效</h2>
          <p className="verdict-seq" data-testid="deviation-verdict-seq">
            第 {outcome.seq} 次比较的结论
          </p>
          <p>
            <code>{outcome.code}</code>：{outcome.message}
          </p>
        </section>
      )}

      {outcome?.kind === 'result' && outcome.value && (
        <section
          className={outcome.value.status === 'ok' ? 'verdict ok' : 'verdict exceeded'}
          role="status"
          data-testid="deviation-verdict"
        >
          {outcome.value.status === 'ok' ? (
            <>
              <h2>✅ 偏差在容许范围内</h2>
              <p className="verdict-seq" data-testid="deviation-verdict-seq">
                第 {outcome.seq} 次比较的结论
              </p>
              <p className="headline">
                精确偏差距离 <strong>{outcome.value.distance}</strong> ≤ 阈值 K ={' '}
                {outcome.value.k}
              </p>
            </>
          ) : (
            <>
              <h2>⚠️ 偏差超出容许范围</h2>
              <p className="verdict-seq" data-testid="deviation-verdict-seq">
                第 {outcome.seq} 次比较的结论
              </p>
              <p className="headline">
                实际偏差距离大于阈值 K = {outcome.value.k}（服务仅返回 exceeded 信号）
              </p>
            </>
          )}
          <dl className="facts">
            <div>
              <dt>计划长度</dt>
              <dd>{outcome.value.lengths.a}</dd>
            </div>
            <div>
              <dt>现场长度</dt>
              <dd>{outcome.value.lengths.b}</dd>
            </div>
            <div>
              <dt>长度差</dt>
              <dd>{Math.abs(outcome.value.lengths.a - outcome.value.lengths.b)}</dd>
            </div>
            <div>
              <dt>阈值 K</dt>
              <dd>{outcome.value.k}</dd>
            </div>
          </dl>
          <details>
            <summary>复核：原始响应</summary>
            <pre>{JSON.stringify(outcome.value, null, 2)}</pre>
          </details>
        </section>
      )}
    </section>
  );
}
