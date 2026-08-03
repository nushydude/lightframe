export type PathCaseSemantics = 'case-sensitive' | 'case-insensitive';

function detectPathCaseSemantics(): PathCaseSemantics {
  if (typeof navigator === 'undefined') return 'case-sensitive';
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform ?? navigator.platform ?? '';
  return /^win/i.test(platform) ? 'case-insensitive' : 'case-sensitive';
}

// Path semantics are detected once for the renderer lifetime. The explicit parameter keeps the
// normalization policy independently testable without mutating process-global state.
let runtimePathCaseSemantics = detectPathCaseSemantics();
interface RootPathCasePolicy {
  root: string;
  semantics: PathCaseSemantics;
}

// Preserve the authority root's spelling. Lower-casing registry keys would collapse distinct
// case-sensitive Windows roots before their reported semantics can be applied.
const rootPathCaseSemantics = new Map<string, RootPathCasePolicy>();

function normalizedPathText(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/$/, '');
}

export function configurePathCaseSemanticsForRoot(
  rootPath: string,
  semantics: PathCaseSemantics
): void {
  const root = normalizedPathText(rootPath);
  rootPathCaseSemantics.set(root, { root, semantics });
}

function semanticsForPath(path: string): PathCaseSemantics {
  const lookup = normalizedPathText(path);
  let bestRoot = '';
  let bestSemantics = runtimePathCaseSemantics;
  for (const policy of rootPathCaseSemantics.values()) {
    const comparablePath = policy.semantics === 'case-insensitive' ? lookup.toLowerCase() : lookup;
    const comparableRoot =
      policy.semantics === 'case-insensitive' ? policy.root.toLowerCase() : policy.root;
    if (
      (comparablePath === comparableRoot || comparablePath.startsWith(`${comparableRoot}/`)) &&
      policy.root.length > bestRoot.length
    ) {
      bestRoot = policy.root;
      bestSemantics = policy.semantics;
    }
  }
  return bestSemantics;
}

export function configurePathCaseSemantics(semantics: PathCaseSemantics): () => void {
  const previous = runtimePathCaseSemantics;
  runtimePathCaseSemantics = semantics;
  return () => {
    runtimePathCaseSemantics = previous;
  };
}

export function pathIdentityKey(path: string, semantics?: PathCaseSemantics): string {
  const normalized = normalizedPathText(path);
  const effectiveSemantics = semantics ?? semanticsForPath(normalized);
  return effectiveSemantics === 'case-insensitive' ? normalized.toLowerCase() : normalized;
}
