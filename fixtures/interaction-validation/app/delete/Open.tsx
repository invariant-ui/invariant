export function FileRow(props: { onDelete: () => void }) {
  return <button onClick={props.onDelete}>Delete file</button>
}
