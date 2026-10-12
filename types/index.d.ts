export type Task = {
  id: string
  title: string
  description: string
  accept?: string
  status: 'todo' | 'claimed' | 'done'
  claim: { owner: string; since: string; expiresAt: string } | null
  notes: { at: string; by: string; text: string }[]
}

declare module 'claude-code' {
  interface PluginState {
    'agent-board': { tasks: Task[]; me: string }
  }
}
