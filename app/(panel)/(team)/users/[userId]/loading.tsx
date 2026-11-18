import { PageSkeleton } from "@/components/ui/Skeletons";

/** The same placeholder the page draws while the user loads, so the two hand over without a jump. */
export default function UserLoading() {
  return <PageSkeleton tiles={0} />;
}
