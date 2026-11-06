import { FamilyWorkspace } from "./workspace";
import { readApiKey } from "@/lib/credentials";

export const dynamic = "force-dynamic";
export default function Page() {
  return <FamilyWorkspace connected={Boolean(readApiKey())} />;
}
