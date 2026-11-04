import { useEffect, useState } from "react"

export function PeopleSearch({ people }: { people: Array<{ id: string; name: string }> }) {
  const [query, setQuery] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const results = people.filter((p) => p.name.includes(query))

  useEffect(() => {
    async function run() {
      setLoading(true)
      try {
        await fetchPeople(query)
      } catch {
        setError("Search failed")
      } finally {
        setLoading(false)
      }
    }
    run()
  }, [query])

  return (
    <div>
      <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} />
      <button onClick={() => setQuery("")}>Clear</button>
      {loading && <p>Loading</p>}
      {error && <p>{error}</p>}
      {results.length === 0 ? <p>No results</p> : results.map((p) => <p key={p.id}>{p.name}</p>)}
    </div>
  )
}

declare function fetchPeople(q: string): Promise<void>
