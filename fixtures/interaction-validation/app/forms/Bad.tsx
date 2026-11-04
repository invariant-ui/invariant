export function NewsletterForm() {
  const subscribe = async () => {
    await fetch("/subscribe")
  }

  return (
    <form onSubmit={subscribe}>
      <input name="email" />
      <button type="submit">Subscribe</button>
    </form>
  )
}
