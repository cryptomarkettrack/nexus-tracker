import clsx from 'clsx'
import type { CSSProperties, ReactNode } from 'react'

export function cn(...args: Parameters<typeof clsx>) {
  return clsx(...args)
}

export function Pct({ value, digits = 2 }: { value: number; digits?: number }) {
  const cls = value > 0.005 ? 'up' : value < -0.005 ? 'down' : 'muted'
  const sign = value > 0 ? '+' : ''
  return (
    <span className={cn('num', cls)}>
      {sign}
      {value.toFixed(digits)}%
    </span>
  )
}

export function Panel({
  title,
  meta,
  children,
  className,
  bodyClassName,
  actions,
  style,
}: {
  title: string
  meta?: string
  children: ReactNode
  className?: string
  bodyClassName?: string
  actions?: ReactNode
  style?: CSSProperties
}) {
  return (
    <section className={cn('panel', className)} style={style}>
      <header className="panel-header">
        <div className="panel-title">{title}</div>
        <div className="row-flex">
          {actions}
          {meta ? <div className="panel-meta">{meta}</div> : null}
        </div>
      </header>
      <div className={cn('panel-body', bodyClassName)}>{children}</div>
    </section>
  )
}
