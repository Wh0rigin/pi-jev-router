/**
 * Error classification: "reasoning difficulty" vs "execution difficulty".
 *
 * Escalating thinking level only helps when the failure stems from insufficient
 * reasoning (logic bugs, compile errors, failing assertions). Network outages,
 * missing daemons, or full disks are environmental — more thinking will not fix
 * them, so they must never trigger an escalation (user spec §8).
 */

export type ErrorKind = "environment" | "reasoning" | "unknown";

export interface ToolFailure {
  /** Short description, e.g. "bash: npm test (exit 1)" */
  label: string;
  /** Error kind as classified. */
  kind: ErrorKind;
  /** Truncated error text for the Jev snapshot / logs. */
  excerpt: string;
  /** True when the tool result looks like a *test run* that failed. */
  isTestFailure: boolean;
  /** True when the tool result looks like a test run (passed or failed). */
  isTestRun: boolean;
}

const ENV_PATTERNS: RegExp[] = [
  /\bECONNREFUSED\b/,
  /\bECONNRESET\b/,
  /\bETIMEDOUT\b/,
  /\bEHOSTUNREACH\b/,
  /\bENETUNREACH\b/,
  /\bENOTFOUND\b/,
  /\bEAI_AGAIN\b/,
  /\bEADDRINUSE\b/,
  /\bENOSPC\b/,
  /\bEPIPE\b/,
  /\bEPROTO\b/,
  /\bECERT\b/,
  /getaddrinfo (ENOTFOUND|EAI_AGAIN|failed)/i,
  /network (error|failure|timeout|unavailable)/i,
  /npm ERR! (network|code ECONN|code ETIMEDOUT)/i,
  /Cannot connect to the Docker daemon/i,
  /docker.*(daemon|desktop).*(not running|isn't running|unavailable)/i,
  /error during connect.*docker/i,
  /request.{0,30}timeout/i,
  /connection (refused|reset|timed out)/i,
  /certificate (verify failed|has expired)/i,
  /SSL.*(error|handshake|certificate)/i,
  /rate limit|too many requests|\b429\b/i,
  /\bHTTP (status )?50[023]\b|\b50[023] (Bad Gateway|Service Unavailable|Internal Server Error)\b/i,
  /quota exceeded|billing|payment required|\b402\b/i,
  /proxy.*(error|refused|timeout)/i,
  /git.*(could not resolve host|failed to connect|connection timed out)/i,
  /permission denied \(publickey\)/i,
  /temporarily unavailable/i,
  /out of (memory|disk space)|no space left on device/i,
  /another program is already using this port/i,
];

const REASONING_PATTERNS: RegExp[] = [
  /\bAssertionError\b/,
  /\bExpect(ed)?\b.*\b(to equal|to be|toEqual|toBe)\b/,
  /\bTypeError\b/,
  /\bReferenceError\b/,
  /\bSyntaxError\b/,
  /\bNullPointerException\b/,
  /\bSegmentation fault\b/,
  /compil(ation)? (error|failed)/i,
  /\berror TS\d+:/,
  /ModuleNotFoundError|No module named/i,
  /Cannot find (module|name)/,
  /\bFAIL(URES|ED|ING)?\b/,
  /\d+ (failing|failed)|tests? failed/i,
  /assert\s+.*failed/i,
  /ENOENT: no such file or directory/i, // usually a wrong path the agent computed
  /is not a function|is not defined|undefined is not/i,
  /Unexpected (token|end of)/i,
];

const TEST_RUN_PATTERNS: RegExp[] = [
  /\bnpm (run )?test\b/,
  /\b(npx )?(jest|vitest|mocha|pytest|py\.test)\b/,
  /\b(go test|cargo test|dotnet test|mvn (surefire:)?test|gradle.*test)\b/,
  /\bnode --test\b/,
  /\bctest\b/,
  /\brake test\b/,
  /\bphpunit\b/,
];

const TEST_FAILURE_PATTERNS: RegExp[] = [
  /\d+ (failing|failed)\b/i,
  /\bFAIL\b/,
  /\bAssertionError\b/,
  /tests? (failed|did not pass)/i,
  /\b✗\b|\b✘\b|✕/,
  /exit code [1-9]/i,
];

export interface RawToolResult {
  toolName: string;
  isError: boolean;
  /** Combined text output (truncated by caller as needed). */
  text: string;
  /** Exit code when available (bash/powershell details). */
  exitCode?: number;
  /** The command, for bash-like tools. */
  command?: string;
  /** Target path, for file tools (read/edit/write). */
  path?: string;
}

/** True when a bash/powershell invocation looks like it ran a test suite. */
export function looksLikeTestRun(raw: RawToolResult): boolean {
  const hay = `${raw.command ?? ""}\n${raw.text.slice(0, 4000)}`;
  return TEST_RUN_PATTERNS.some((re) => re.test(hay));
}

function looksLikeTestFailure(raw: RawToolResult, isTestRun: boolean): boolean {
  if (!isTestRun) return false;
  if (typeof raw.exitCode === "number" && raw.exitCode !== 0) return true;
  return TEST_FAILURE_PATTERNS.some((re) => re.test(raw.text.slice(0, 8000)));
}

export function classifyText(text: string): ErrorKind {
  if (ENV_PATTERNS.some((re) => re.test(text))) return "environment";
  if (REASONING_PATTERNS.some((re) => re.test(text))) return "reasoning";
  return "unknown";
}

/**
 * Classify one finalized tool result. Only failures (isError or non-zero exit)
 * produce a ToolFailure; successful results are not failures.
 */
export function classifyToolResult(raw: RawToolResult): ToolFailure | null {
  const isTestRun = looksLikeTestRun(raw);
  const failed =
    raw.isError || (typeof raw.exitCode === "number" && raw.exitCode !== 0);
  if (!failed) return null;

  // We only get here for failed results, so a test run that failed is a test failure.
  const isTestFailure = isTestRun;

  const kind = classifyText(raw.text.slice(0, 8000));
  return {
    label: `${raw.toolName}${raw.command ? `: ${raw.command.slice(0, 80)}` : ""}`,
    kind,
    excerpt: raw.text.replace(/\s+/g, " ").slice(0, 240),
    isTestFailure,
    isTestRun,
  };
}
