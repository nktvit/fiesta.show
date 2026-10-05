import { Component, computed, input, model } from '@angular/core';

let rowSeq = 0;

/**
 * One labelled setting: label + description on the left, a control on the right.
 * With `kind="switch"` it renders the switch itself (bind `[(checked)]`); with
 * `kind="custom"` the control is projected. The row carries `id="setting-<id>"`
 * so the in-page search can scroll to and highlight it.
 */
@Component({
  selector: 'app-music-setting-row',
  templateUrl: './music-setting-row.component.html',
  host: { class: 'block' },
})
export class MusicSettingRowComponent {
  readonly id = input.required<string>();
  readonly label = input.required<string>();
  readonly description = input<string>('');
  /** Amber note shown under the description (e.g. why the control is disabled). */
  readonly note = input<string>('');
  readonly kind = input<'switch' | 'custom'>('custom');
  readonly disabled = input(false);
  readonly checked = model(false);

  private readonly uid = ++rowSeq;
  protected readonly rowId = computed(() => 'setting-' + this.id());
  protected readonly labelId = computed(() => `setting-label-${this.uid}`);
  protected readonly descId = computed(() => `setting-desc-${this.uid}`);

  protected toggle(): void {
    if (!this.disabled()) this.checked.set(!this.checked());
  }
}
