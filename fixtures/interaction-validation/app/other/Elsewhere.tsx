// Outside every policy's paths: none of the interaction rules apply here.
export function Elsewhere() {
  const remove = async () => {
    await removeThing()
  }
  return (
    <form onSubmit={async () => { await fetch("/x") }}>
      <button onClick={remove}>Delete</button>
    </form>
  )
}

declare function removeThing(): Promise<void>
