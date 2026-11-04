export function FeedbackForm(props: { onSubmit: () => void }) {
  return (
    <form onSubmit={props.onSubmit}>
      <textarea name="note" />
      <button type="submit">Send</button>
    </form>
  )
}
