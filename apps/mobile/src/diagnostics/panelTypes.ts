import type { CheckId } from './catalog';
import type { CheckResult } from './runner';

export interface PanelProps {
  /** Records a result for one of this panel's checks. */
  onResult: (id: CheckId, result: CheckResult) => void;
}
