import { useState } from "react"

export function BareSearch() {
  const [q, setQ] = useState("")

  return (
    <div>
      <input value={q} onChange={(e) => setQ(e.target.value)} />
    </div>
  )
}
