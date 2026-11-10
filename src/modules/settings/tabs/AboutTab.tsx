import { MessageSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { APP_BRAND_NAME, CLOUDCLI_WORDMARK_FONT_FAMILY } from '@/shared/constants';
import { useVersionCheck } from '@/shared/hooks/useVersionCheck';

// cloudcli-multi: the GitHub star button, GitHub/Discord/Docs/cloudcli.ai links,
// the hosted and Pro upsell cards and the update badge are removed; the page
// keeps the product name, version and license.

/** Rendered by Settings for the "about" tab, showing the product name, version and license. */
export default function AboutTab() {
  const { t } = useTranslation('settings');
  const { currentVersion } = useVersionCheck();

  return (
    <div className="space-y-6">
      {/* Logo + name + version */}
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-primary/90 shadow-sm">
          <MessageSquare className="h-5 w-5 text-primary-foreground" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <span
              className="text-base font-semibold text-foreground"
              style={{ fontFamily: CLOUDCLI_WORDMARK_FONT_FAMILY }}
            >
              {APP_BRAND_NAME}
            </span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              v{currentVersion}
            </span>
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {t('about.tagline')}
          </p>
        </div>
      </div>

      {/* License */}
      <div className="border-t border-border/50 pt-4">
        <p className="text-xs text-muted-foreground/60">
          {t('about.licensed')}
        </p>
      </div>
    </div>
  );
}
