// The snyvi mod's state: the band's line above the prompt, as the daemon last
// gave it (`GET /api/panes/{id}/band`). Empty draws nothing.
export type Band = string

declare module 'claude-code' {
  interface PluginState {
    snyvi: { band: Band }
  }
}
