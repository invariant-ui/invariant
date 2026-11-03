import { createContext, type ReactNode } from "react"

const CardContext = createContext<{ elevated: boolean }>({ elevated: false })

export interface CardProps {
  elevated?: boolean
  children?: ReactNode
}

function CardRoot({ elevated = false, children }: CardProps) {
  return (
    <CardContext.Provider value={{ elevated }}>
      <div className="card">{children}</div>
    </CardContext.Provider>
  )
}

function CardHeader({ title }: { title: string }) {
  return <header>{title}</header>
}

function CardBody({ children }: { children: ReactNode }) {
  return <section>{children}</section>
}

export const Card = Object.assign(CardRoot, { Header: CardHeader, Body: CardBody })
