import LatticeLoader from './LatticeLoader'

export interface TaskItem {
  id: string
  title: string
  label: string
  done: number
  total: number
  status: 'working' | 'done' | 'error'
  error?: string
}

function TaskCard({ task }: { task: TaskItem }) {
  const percent =
    task.total > 0 ? Math.min(100, Math.round((task.done / task.total) * 100)) : 0

  return (
    <div className="task-card">
      <p className="task-title" title={task.title}>
        {task.title}
      </p>
      <LatticeLoader
        status={task.status}
        label={task.label}
        doneLabel="用时"
        errorLabel="失败于"
        color="var(--accent)"
        pattern="orbit"
        grid={3}
        shape="round"
        cellSize={6}
        gap={2}
        fontSize={13}
        step={90}
        idleOpacity={0.16}
        showTimer
      />
      {task.status === 'working' && task.total > 0 && (
        <div className="task-meta">
          <div className="task-track">
            <div className="task-fill" style={{ width: `${percent}%` }} />
          </div>
          <span className="task-count">
            {task.done}/{task.total}
          </span>
        </div>
      )}
      {task.status === 'error' && task.error && <p className="task-error">{task.error}</p>}
    </div>
  )
}

export default function TaskStack({ tasks }: { tasks: TaskItem[] }) {
  if (!tasks.length) return null
  return (
    <div className="task-stack">
      {tasks.map((task) => (
        <TaskCard key={task.id} task={task} />
      ))}
    </div>
  )
}
