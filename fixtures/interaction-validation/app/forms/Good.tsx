import { useState } from "react"

export function ContactForm() {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(event: { preventDefault(): void }) {
    event.preventDefault()
    if (submitting) return
    setSubmitting(true)
    try {
      await save()
      navigate("/thanks")
    } catch {
      setError("Could not send your message")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={submitting}>
        {submitting ? "Sending" : "Send"}
      </button>
    </form>
  )
}

declare function save(): Promise<void>
declare function navigate(to: string): void
