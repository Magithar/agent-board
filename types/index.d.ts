export type Task = {
  id: string
  title: string
  description: string
  accept?: string
  status: 'todo' | 'claimed' | 'done'
  claim: { owner: string; since: string; expiresAt: string } | null
  notes: { at: string; by: string; text: string }[]
}

export type Agent = { name: string; lastSeen: string }

export type Usage = {
  limits: { kind: string; percentUsed: number; resetsAt?: string }[]
  context?: number
  costUsd?: number
}

declare module 'claude-code' {
  interface PluginState {
    'agent-board': { tasks: Task[]; agents: Agent[]; me: string; usage: Usage }
  }
}
