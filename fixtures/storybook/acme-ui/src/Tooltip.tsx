export function Tooltip({ content, children, open }: { content: React.ReactNode; children: React.ReactElement; open?: boolean }) {
  return (
    <>
      {children}
      {open && <div role="tooltip">{content}</div>}
    </>
  )
}
