import type { ReactNode } from "react";

export function PlaceholderView({
  title,
  description,
  icon,
}: {
  title: string;
  description: string;
  icon?: ReactNode;
}) {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="max-w-md text-center">
        {icon && (
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            {icon}
          </div>
        )}
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}
