export function TeamRow({ id }: { id: string }) {
  const remove = async () => {
    await removeTeam(id)
  }

  return <button onClick={remove}>Remove team</button>
}

declare function removeTeam(id: string): Promise<void>
