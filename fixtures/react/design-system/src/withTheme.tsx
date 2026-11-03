export function withTheme<P extends object>(Wrapped: React.ComponentType<P>) {
  return function Themed(props: P) {
    return <Wrapped {...props} />
  }
}
