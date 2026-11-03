export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return <svg aria-hidden="true" role="img" width={size} height={size} data-name={name} />
}
