/** A note as the band and the hints name it. */
export type NoteRef = { id: string; title: string }

declare module 'claude-code' {
  interface PluginState {
    'simple-memory': {
      /** Notes hinted this conversation, oldest first; each hinted once. */
      suggested: NoteRef[]
      /** Notes read this conversation, oldest first. */
      read: NoteRef[]
    }
  }
}
