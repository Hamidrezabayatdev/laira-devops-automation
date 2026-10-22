import { DemoBanner } from '@/components/demo/demo-banner';
import { AppShell } from '@/components/layout/app-shell';
import { DemoView } from '@/components/demo/demo-view';

export const metadata = {
  title: 'دموی شبیه‌سازی‌شده (Fixture Demo) — لیارا DevOps',
};

export default function DemoPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <DemoBanner />
      <AppShell
        isDemo={true}
        workspaceName="فضای کاری آزمایشی (Demo)"
        workspaceId="ws_demo_simulation"
      >
        <DemoView />
      </AppShell>
    </div>
  );
}
