import { useState } from "react"

export function ProjectRow({ id }: { id: string }) {
  const [open, setOpen] = useState(false)

  const remove = async () => {
    await deleteProject(id)
    setOpen(false)
  }

  return (
    <div>
      <button onClick={() => setOpen(true)}>Delete</button>
      {open && (
        <dialog open>
          <p>Delete this project?</p>
          <button onClick={remove}>Delete</button>
          <button onClick={() => setOpen(false)}>Cancel</button>
        </dialog>
      )}
    </div>
  )
}

declare function deleteProject(id: string): Promise<void>
