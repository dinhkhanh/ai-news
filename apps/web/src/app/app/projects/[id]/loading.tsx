export default function ProjectLoading() {
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="space-y-2">
        <div className="h-3 w-20 animate-pulse rounded bg-muted" />
        <div className="h-7 w-2/3 max-w-lg animate-pulse rounded bg-muted" />
        <div className="h-5 w-48 animate-pulse rounded bg-muted" />
      </div>
      <div className="h-52 animate-pulse rounded-xl border bg-muted/40" />
      <div className="h-40 animate-pulse rounded-xl border bg-muted/40" />
    </div>
  );
}
