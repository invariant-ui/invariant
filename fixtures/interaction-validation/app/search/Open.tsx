import { useState } from "react"
import { useResults } from "./useResults"

export function HookedSearch() {
  const [q, setQ] = useState("")
  const results = useResults(q)

  return (
    <div>
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} />
      <ul>{results}</ul>
    </div>
  )
}
