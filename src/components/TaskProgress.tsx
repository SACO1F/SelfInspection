export interface TaskState {
  label: string
  done: number
  total: number
}

export default function TaskProgress({ task }: { task: TaskState | null }) {
  if (!task) return null
  const percent = task.total > 0 ? Math.min(100, Math.round((task.done / task.total) * 100)) : 0

  return (
    <div className="task-card">
      <div className="task-head">
        <span className="spinner" />
        <span className="task-label">{task.label}</span>
      </div>
      {task.total > 0 && (
        <>
          <div className="task-track">
            <div className="task-fill" style={{ width: `${percent}%` }} />
          </div>
          <div className="task-count">
            {task.done} / {task.total}
          </div>
        </>
      )}
    </div>
  )
}
