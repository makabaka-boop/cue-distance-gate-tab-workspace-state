/**
 * Web-layer acceptance: the two entries (performance console / deviation
 * checker) must keep isolated state across tab round-trips.
 *
 * Every fetch goes through a controllable deferred so the suite decides the
 * exact order in which multiple in-flight Promises settle. Switch points are
 * exercised before the request, after submit but before the response, and
 * after a rejection. Assertions cover: session identity, version, cue
 * uniqueness, cue draft, busy state, error state and deviation verdicts.
 *
 * The real server adjudication (requestId / expectedVersion / distance) is
 * unaffected — the suite drives the same src/api.ts client.
 */
import { act } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import App from '../App';
import type { DistanceResponse, Performance } from '../api';

// ------------------------------------------------------------------ harness

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface RecordedRequest {
  method: string;
  path: string;
  body: any;
  defer: Deferred<Response>;
}

class MockApi {
  requests: RecordedRequest[] = [];
  private handler: ((r: RecordedRequest) => void) | null = null;

  reset() {
    this.requests = [];
    this.handler = null;
  }

  /** Observe the next matching request without resolving it. */
  take(predicate: (r: RecordedRequest) => boolean): Promise<RecordedRequest> {
    return new Promise((resolve) => {
      const existing = this.requests.find(predicate);
      if (existing) return resolve(existing);
      const prev = this.handler;
      this.handler = (r) => {
        if (predicate(r)) {
          this.handler = prev;
          resolve(r);
        } else {
          prev?.(r);
        }
      };
    });
  }

  json(status: number, payload: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    } as Response;
  }

  okPerformance(p: Performance): Response {
    return this.json(200, { status: 'ok', performance: p });
  }

  rejected(reason: string): Response {
    return this.json(409, {
      error: { code: 'COMMAND_REJECTED', reason, message: `${reason} detail` },
    });
  }

  distance(body: DistanceResponse): Response {
    return this.json(200, body);
  }

  install() {
    const api = this;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: any, init?: any) => {
        const url = String(typeof input === 'string' ? input : input.url);
        const path = url.replace(/^https?:\/\/[^/]+/, '');
        const body = init?.body ? JSON.parse(init.body) : undefined;
        const rec: RecordedRequest = {
          method: (init?.method ?? 'GET').toUpperCase(),
          path,
          body,
          defer: deferred<Response>(),
        };
        api.requests.push(rec);
        api.handler?.(rec);
        return rec.defer.promise;
      }),
    );
  }
}

const mock = new MockApi();

function snapshot(over: Partial<Performance> = {}): Performance {
  return {
    id: 'p-default',
    name: '默认场次',
    status: 'pending',
    version: 1,
    requestId: null,
    cues: [],
    ...over,
  };
}

function settle(rec: RecordedRequest, response: Response) {
  return act(async () => {
    rec.defer.resolve(response);
    // Flush the .json() await and React's state updates.
    await Promise.resolve();
    await Promise.resolve();
  });
}

const consoleTab = () => screen.getByRole('tab', { name: '演出场次控制台' });
const deviationTab = () => screen.getByRole('tab', { name: 'Cue 序列偏差校验' });
const consolePanel = () => screen.getByTestId('console-panel');
const deviationPanel = () => screen.getByTestId('deviation-panel');

function goConsole() {
  fireEvent.click(consoleTab());
}
function goDeviation() {
  fireEvent.click(deviationTab());
}

async function createPerformance(name: string, id: string): Promise<RecordedRequest> {
  fireEvent.change(screen.getByTestId('create-name'), { target: { value: name } });
  fireEvent.click(screen.getByTestId('create-button'));
  const rec = await mock.take(
    (r) => r.method === 'POST' && r.path === '/api/performances/commands' && r.body?.command === 'create',
  );
  await settle(rec, mock.okPerformance(snapshot({ id, name, requestId: rec.body.requestId })));
  return rec;
}

beforeEach(() => {
  mock.reset();
  mock.install();
  render(<App />);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// --------------------------------------------------------------------- tests

describe('entry state survives tab round-trips', () => {
  test('open session, name draft, load id draft and errors are preserved off-screen', async () => {
    await createPerformance('晚场 A', 'perf-A');

    // Session open on console; also leave a load-id draft.
    fireEvent.change(screen.getByTestId('load-id'), { target: { value: 'draft-load-id' } });
    expect(within(consolePanel()).getByTestId('session-name').textContent).toBe('晚场 A');

    // A failed load surfaces an error without wiping the open session.
    fireEvent.click(screen.getByTestId('load-button'));
    const load = await mock.take((r) => r.method === 'GET');
    await settle(
      load,
      mock.json(404, { error: { code: 'SESSION_NOT_FOUND', message: 'not found' } }),
    );

    goDeviation();
    // While hidden, the console DOM (and state) stays mounted.
    expect(deviationPanel().style.display).toBe('block');
    expect(consolePanel().style.display).toBe('none');
    expect(consolePanel().querySelector('[data-testid="session-name"]')?.textContent).toBe(
      '晚场 A',
    );

    goConsole();
    const panel = consolePanel();
    expect(within(panel).getByTestId('session-id').textContent).toBe('perf-A');
    expect(within(panel).getByTestId('session-version').textContent).toBe('1');
    expect((within(panel).getByTestId('load-id') as HTMLInputElement).value).toBe('draft-load-id');
    expect(within(panel).getByTestId('console-error').textContent).toContain('SESSION_NOT_FOUND');
    expect(panel.querySelector('[data-testid="console-empty"]')).toBeNull();
  });
});

describe('in-flight command completes against its own session after round-trip', () => {
  test('cue draft survives while pending; commit clears it, advances version, cue appears once', async () => {
    await createPerformance('晚场 B', 'perf-B');
    fireEvent.click(screen.getByTestId('start-button'));
    const start = await mock.take((r) => r.body?.command === 'transition');
    expect(start.body.expectedVersion).toBe(1);
    await settle(
      start,
      mock.okPerformance(
        snapshot({ id: 'perf-B', name: '晚场 B', status: 'running', version: 2, requestId: 'r-start' }),
      ),
    );

    // Fill a cue and submit; switch BEFORE the response arrives.
    fireEvent.change(screen.getByTestId('cue-input'), { target: { value: '101' } });
    fireEvent.click(screen.getByTestId('cue-register'));
    const cue = await mock.take((r) => r.body?.command === 'registerCue');
    expect(cue.body.performanceId).toBe('perf-B');
    expect(cue.body.cue).toBe(101);
    expect(cue.body.expectedVersion).toBe(2);

    // The input is disabled while busy and — crucially — still holds 101:
    // the draft is no longer cleared before the request is sent.
    const cueInput = within(consolePanel()).getByTestId('cue-input') as HTMLInputElement;
    expect(cueInput.value).toBe('101');
    expect(cueInput.disabled).toBe(true);

    goDeviation();
    goConsole();
    expect(within(consolePanel()).getByTestId('cue-input').getAttribute('value')).toBe('101');

    // Server accepts: response reaches the kept-alive console.
    await settle(
      cue,
      mock.okPerformance(
        snapshot({
          id: 'perf-B',
          name: '晚场 B',
          status: 'running',
          version: 3,
          requestId: cue.body.requestId,
          cues: [101],
        }),
      ),
    );

    const panel = consolePanel();
    expect(within(panel).getByTestId('session-version').textContent).toBe('3');
    expect(within(panel).getByTestId('cue-count').textContent).toBe('1');
    const values = within(panel)
      .getAllByText('101', { selector: '.cue-value' })
      .map((n) => n.textContent);
    expect(values).toEqual(['101']);
    expect((within(panel).getByTestId('cue-input') as HTMLInputElement).value).toBe('');
    expect(
      (within(panel).getByTestId('cue-register') as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(panel.querySelector('[data-testid="console-error"]')).toBeNull();
  });

  test('VERSION_CONFLICT after round-trip keeps the draft and the prior version; deviation entry untouched', async () => {
    await createPerformance('晚场 C', 'perf-C');
    fireEvent.click(screen.getByTestId('start-button'));
    const start = await mock.take((r) => r.body?.command === 'transition');
    await settle(
      start,
      mock.okPerformance(
        snapshot({ id: 'perf-C', name: '晚场 C', status: 'running', version: 2, requestId: 'r2' }),
      ),
    );

    // Leave distinct drafts on the deviation entry first.
    goDeviation();
    fireEvent.change(within(deviationPanel()).getByTestId('plan-input'), {
      target: { value: '[1,2,3]' },
    });
    fireEvent.change(within(deviationPanel()).getByTestId('live-input'), {
      target: { value: '[1,3]' },
    });
    fireEvent.change(within(deviationPanel()).getByTestId('k-input'), { target: { value: '1' } });

    goConsole();
    fireEvent.change(screen.getByTestId('cue-input'), { target: { value: '205' } });
    fireEvent.click(screen.getByTestId('cue-register'));
    const cue = await mock.take((r) => r.body?.command === 'registerCue');

    goDeviation();
    goConsole();

    // Server rejects: nothing committed.
    await settle(cue, mock.rejected('VERSION_CONFLICT'));

    const panel = consolePanel();
    expect(within(panel).getByTestId('session-version').textContent).toBe('2');
    expect(within(panel).getByTestId('cue-count').textContent).toBe('0');
    expect(within(panel).getByTestId('console-error').textContent).toContain('VERSION_CONFLICT');
    // The failed cue is still identifiable and retryable.
    expect((within(panel).getByTestId('cue-input') as HTMLInputElement).value).toBe('205');
    expect((within(panel).getByTestId('cue-register') as HTMLButtonElement).disabled).toBe(false);

    // The other entry's full state is intact and carries no error.
    goDeviation();
    const d = deviationPanel();
    expect((within(d).getByTestId('plan-input') as HTMLTextAreaElement).value).toBe('[1,2,3]');
    expect((within(d).getByTestId('live-input') as HTMLTextAreaElement).value).toBe('[1,3]');
    expect((within(d).getByTestId('k-input') as HTMLInputElement).value).toBe('1');
    expect(d.querySelector('[data-testid="deviation-error"]')).toBeNull();
  });
});

describe('stale responses target only their own session and entry', () => {
  test('a slow response for a previously displayed session never switches back the view', async () => {
    // Create session A and leave a slow GET for A in flight.
    await createPerformance('场次 X', 'perf-X');
    fireEvent.change(screen.getByTestId('load-id'), { target: { value: 'perf-X' } });
    fireEvent.click(screen.getByTestId('load-button'));
    const slowLoad = await mock.take((r) => r.method === 'GET');

    // Create session B meanwhile: its command is the latest user action.
    fireEvent.change(screen.getByTestId('create-name'), { target: { value: '场次 Y' } });
    fireEvent.click(screen.getByTestId('create-button'));
    const createB = await mock.take(
      (r) => r.body?.command === 'create' && r.body.name === '场次 Y',
    );

    // Resolve B first: the view switches to B.
    await settle(
      createB,
      mock.okPerformance(snapshot({ id: 'perf-Y', name: '场次 Y', requestId: 'rb' })),
    );
    expect(within(consolePanel()).getByTestId('session-id').textContent).toBe('perf-Y');

    goDeviation();
    goConsole();

    // Now the stale A load lands: it must not pull the view back to A.
    await settle(
      slowLoad,
      mock.okPerformance(
        snapshot({
          id: 'perf-X',
          name: '场次 X',
          status: 'running',
          version: 4,
          requestId: 'rx',
          cues: [9],
        }),
      ),
    );
    const panel = consolePanel();
    expect(within(panel).getByTestId('session-id').textContent).toBe('perf-Y');
    expect(within(panel).getByTestId('session-name').textContent).toBe('场次 Y');
    expect(within(panel).getByTestId('session-version').textContent).toBe('1');
    expect(within(panel).getByTestId('cue-count').textContent).toBe('0');
    expect(panel.querySelector('[data-testid="console-error"]')).toBeNull();
  });

  test('a stale command commit for session A never updates session B (identity gate)', async () => {
    // A is running, cue 101 is submitted and stays pending.
    await createPerformance('场次 A', 'perf-A');
    fireEvent.click(screen.getByTestId('start-button'));
    const start = await mock.take((r) => r.body?.command === 'transition');
    await settle(
      start,
      mock.okPerformance(
        snapshot({ id: 'perf-A', name: '场次 A', status: 'running', version: 2, requestId: 'rA0' }),
      ),
    );
    fireEvent.change(screen.getByTestId('cue-input'), { target: { value: '101' } });
    fireEvent.click(screen.getByTestId('cue-register'));
    const cueA = await mock.take((r) => r.body?.command === 'registerCue');

    // While that command is on the wire, a load brings session B into view.
    fireEvent.change(screen.getByTestId('load-id'), { target: { value: 'perf-B' } });
    fireEvent.click(screen.getByTestId('load-button'));
    const loadB = await mock.take((r) => r.method === 'GET');
    await settle(
      loadB,
      mock.okPerformance(
        snapshot({ id: 'perf-B', name: '场次 B', status: 'running', version: 5, requestId: 'rB', cues: [7] }),
      ),
    );
    expect(within(consolePanel()).getByTestId('session-id').textContent).toBe('perf-B');

    goDeviation();
    goConsole();

    // A's accepted commit lands afterwards: it belongs to A and must not
    // switch the view, bump B's version or add A's cue to B's timeline.
    await settle(
      cueA,
      mock.okPerformance(
        snapshot({
          id: 'perf-A',
          name: '场次 A',
          status: 'running',
          version: 3,
          requestId: cueA.body.requestId,
          cues: [101],
        }),
      ),
    );
    const panel = consolePanel();
    expect(within(panel).getByTestId('session-id').textContent).toBe('perf-B');
    expect(within(panel).getByTestId('session-version').textContent).toBe('5');
    expect(within(panel).getByTestId('cue-count').textContent).toBe('1');
    expect(panel.querySelector('.cue-value')?.textContent).toBe('7');
    expect(panel.querySelector('[data-testid="console-error"]')).toBeNull();
  });
});

describe('deviation request identity across round-trips', () => {
  test('inputs and busy state survive; stale comparison cannot replace the latest verdict', async () => {
    goDeviation();
    fireEvent.change(within(deviationPanel()).getByTestId('plan-input'), {
      target: { value: '[1,2,3]' },
    });
    fireEvent.change(within(deviationPanel()).getByTestId('live-input'), {
      target: { value: '[1,3]' },
    });
    fireEvent.change(within(deviationPanel()).getByTestId('k-input'), { target: { value: '2' } });

    // First comparison in flight, then switch before it resolves.
    fireEvent.click(within(deviationPanel()).getByTestId('compare-button'));
    const first = await mock.take((r) => r.path === '/api/distance');
    expect(within(deviationPanel()).getByTestId('compare-button').textContent).toContain('校验中');

    goConsole();
    goDeviation();
    // Inputs untouched while hidden; request still outstanding.
    const d = deviationPanel();
    expect((within(d).getByTestId('plan-input') as HTMLTextAreaElement).value).toBe('[1,2,3]');
    expect(within(d).getByTestId('compare-button').textContent).toContain('校验中');

    // First verdict lands while back on the entry.
    await settle(
      first,
      mock.distance({ status: 'ok', distance: 1, k: 2, lengths: { a: 3, b: 2 } }),
    );
    expect(within(d).getByTestId('deviation-verdict-seq').textContent).toContain('第 1 次比较');
    expect(within(d).getByText(/精确偏差距离/).textContent).toContain('1');

    // Second comparison with different inputs.
    fireEvent.change(within(d).getByTestId('live-input'), { target: { value: '[]' } });
    fireEvent.change(within(d).getByTestId('k-input'), { target: { value: '5' } });
    fireEvent.click(within(d).getByTestId('compare-button'));
    const second = await mock.take(
      (r) => r.path === '/api/distance' && JSON.stringify(r.body.b) === '[]',
    );

    // Resolve the stale FIRST conclusion (exceeded) after the second submit;
    // it must be dropped because its request identity is no longer current.
    await settle(
      first,
      mock.distance({ status: 'exceeded', k: 2, lengths: { a: 3, b: 2 } }),
    );
    expect(d.querySelector('[data-testid="deviation-verdict"]')).toBeNull();
    expect(within(d).getByTestId('compare-button').textContent).toContain('校验中');

    // Second verdict lands: identifiable as the 2nd comparison, its own data.
    await settle(
      second,
      mock.distance({ status: 'ok', distance: 3, k: 5, lengths: { a: 3, b: 0 } }),
    );
    expect(within(d).getByTestId('deviation-verdict-seq').textContent).toContain('第 2 次比较');
    expect(within(d).getByText(/精确偏差距离/).textContent).toContain('3');
    // Drafts of the second comparison preserved.
    expect((within(d).getByTestId('live-input') as HTMLTextAreaElement).value).toBe('[]');
    expect((within(d).getByTestId('k-input') as HTMLInputElement).value).toBe('5');
  });

  test('a stale failure cannot overwrite the latest result; busy settles per request', async () => {
    goDeviation();
    fireEvent.click(within(deviationPanel()).getByTestId('compare-button'));
    const first = await mock.take((r) => r.path === '/api/distance');

    fireEvent.click(within(deviationPanel()).getByTestId('compare-button'));
    const second = await mock.take(
      (r) => r.path === '/api/distance' && r !== (first as unknown),
    );
    expect(within(deviationPanel()).getByTestId('compare-button').textContent).toContain('在途 2');

    // Newest succeeds first.
    await settle(
      second,
      mock.distance({ status: 'ok', distance: 0, k: 3, lengths: { a: 8, b: 7 } }),
    );
    expect(within(deviationPanel()).getByTestId('deviation-verdict-seq').textContent).toContain(
      '第 2 次比较',
    );
    expect(within(deviationPanel()).getByTestId('compare-button').textContent).toContain('在途 1');

    // Oldest fails afterwards: its error must not replace the good verdict.
    await settle(
      first,
      mock.json(500, { error: { code: 'INTERNAL', message: 'boom' } }),
    );
    const d = deviationPanel();
    expect(within(d).getByTestId('deviation-verdict-seq').textContent).toContain('第 2 次比较');
    expect(d.querySelector('[data-testid="deviation-error"]')).toBeNull();
    await waitFor(() =>
      expect(within(d).getByTestId('compare-button').textContent).toBe('比较'),
    );
  });

  test('failure after a round-trip lands on the deviation entry only, keeping its inputs', async () => {
    goDeviation();
    fireEvent.change(within(deviationPanel()).getByTestId('plan-input'), {
      target: { value: '[10,20]' },
    });
    fireEvent.change(within(deviationPanel()).getByTestId('live-input'), {
      target: { value: '[10]' },
    });
    fireEvent.change(within(deviationPanel()).getByTestId('k-input'), { target: { value: '0' } });

    fireEvent.click(within(deviationPanel()).getByTestId('compare-button'));
    const req = await mock.take((r) => r.path === '/api/distance');

    // Switch away before the failure, then come back; the failure must still
    // be attributable to this exact (1st) comparison and this entry only.
    goConsole();
    await settle(
      req,
      mock.json(400, { error: { code: 'INVALID_ELEMENT', message: 'bad element' } }),
    );
    expect(consolePanel().querySelector('[data-testid="console-error"]')).toBeNull();

    goDeviation();
    const d = deviationPanel();
    expect(within(d).getByTestId('deviation-error').textContent).toContain('INVALID_ELEMENT');
    expect(within(d).getByTestId('deviation-verdict-seq').textContent).toContain('第 1 次比较');
    expect((within(d).getByTestId('plan-input') as HTMLTextAreaElement).value).toBe('[10,20]');
    expect((within(d).getByTestId('live-input') as HTMLTextAreaElement).value).toBe('[10]');
    expect(within(d).getByTestId('compare-button').textContent).toBe('比较');
  });
});

describe('cross-entry isolation', () => {
  test('in-flight deviation settling does not touch the console session', async () => {
    await createPerformance('隔离场', 'perf-I');
    goDeviation();
    fireEvent.click(within(deviationPanel()).getByTestId('compare-button'));
    const dist = await mock.take((r) => r.path === '/api/distance');

    goConsole();
    await settle(
      dist,
      mock.distance({ status: 'exceeded', k: 3, lengths: { a: 3, b: 2 } }),
    );

    const panel = consolePanel();
    expect(within(panel).getByTestId('session-id').textContent).toBe('perf-I');
    expect(within(panel).getByTestId('session-version').textContent).toBe('1');
    expect(panel.querySelector('[data-testid="console-error"]')).toBeNull();

    goDeviation();
    expect(within(deviationPanel()).getByTestId('deviation-verdict-seq').textContent).toContain(
      '第 1 次比较',
    );
  });
});
