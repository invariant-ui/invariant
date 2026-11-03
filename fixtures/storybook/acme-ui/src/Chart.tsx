export default function Chart({ data }: { data: number[] }) {
  return <svg data-points={data.length} />
}
