// Paths on Windows and Unix alike. The plugin keeps every path it builds
// with forward slashes (Windows file APIs accept them), and compares paths
// that come from elsewhere (a tool's file_path, a setting) only through
// these helpers: backslashes become slashes, and on Windows the comparison
// ignores case, as the file system does.

/** Whether a path is a Windows one: a drive (`C:\`, `c:/`) or a UNC share (`\\server`). */
export const isWindowsPath = (path: string) => /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}[^\\/]/.test(path)

/** Whether a path is absolute: `/…`, a drive or a UNC share. */
export const isAbsolute = (path: string) => path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(path)

/**
 * The path with forward slashes, repeated slashes collapsed (a UNC share's
 * leading pair kept), a drive letter upper-cased, and no trailing slash.
 */
export const normalize = (path: string): string => {
  const slashed = path.replace(/\\/g, '/')
  const isUnc = /^\/\/[^/]/.test(slashed)
  let out = slashed.replace(/\/{2,}/g, '/')
  if (isUnc) out = `/${out}`
  out = out.replace(/^([a-z]):/, (_, drive: string) => `${drive.toUpperCase()}:`)
  return out.length > 1 && !/^[A-Za-z]:\/$/.test(out) ? out.replace(/\/+$/, '') : out
}

/** A key two spellings of one path share: normalized, and lower-cased on Windows. */
export const pathKey = (path: string) => {
  const out = normalize(path)
  return isWindowsPath(out) ? out.toLowerCase() : out
}

/** `path` relative to `root` (with forward slashes) when it lies inside it, else undefined. */
export const relativeTo = (path: string, root: string): string | undefined => {
  const base = pathKey(root)
  const full = normalize(path)
  const key = pathKey(full)
  if (!key.startsWith(`${base}/`)) return undefined
  return full.slice(base.length + 1)
}

/**
 * Deletes a file through a host command: `rm` where there is one, else
 * `cmd /c del` (Windows). Either way, it is a success only if the file is gone
 * afterwards; `del` exits 0 even when it deleted nothing.
 */
export const removeFile = async (
  run: (argv: readonly string[]) => Promise<{ exitCode: number; stderr: string }>,
  exists: (path: string) => Promise<boolean>,
  path: string,
): Promise<void> => {
  const isWindows = isWindowsPath(path)
  const attempts: (readonly string[])[] = isWindows
    ? [['cmd', '/c', 'del', '/f', '/q', path.replace(/\//g, '\\')], ['rm', '-f', '--', path]]
    : [['rm', '-f', '--', path]]
  let reason = ''
  for (const argv of attempts) {
    const ran = await run(argv).catch((error: unknown) => {
      reason = error instanceof Error ? error.message : String(error)
      return undefined
    })
    if (ran && ran.exitCode !== 0) reason = ran.stderr.trim() || `${argv[0]} exited ${ran.exitCode}`
    if (ran && !(await exists(path))) return
  }
  throw new Error(`could not delete ${path}${reason ? `: ${reason}` : ''}`)
}
