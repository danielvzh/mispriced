import { MispricedClient } from "@/components/MispricedClient";

export default function Home() {
  return (
    <div className="flex min-h-dvh flex-col bg-[#F8F8F8]">
      <main className="min-h-0 flex-1 overflow-hidden">
        <MispricedClient />
      </main>
      <footer
        className="h-1.5 w-full shrink-0 bg-[#B51822]"
        aria-hidden
      />
    </div>
  );
}
