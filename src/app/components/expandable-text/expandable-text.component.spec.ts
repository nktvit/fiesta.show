import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ExpandableTextComponent } from './expandable-text.component';

describe('ExpandableTextComponent', () => {
  let fixture: ComponentFixture<ExpandableTextComponent>;
  let component: ExpandableTextComponent;

  const long = (n: number) =>
    Array.from({ length: n }, (_, i) => `Paragraph ${i}. ${'word '.repeat(80)}`);

  const setUp = async (paragraphs: string[], collapsedLines = 3) => {
    fixture = TestBed.createComponent(ExpandableTextComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('paragraphs', paragraphs);
    fixture.componentRef.setInput('collapsedLines', collapsedLines);
    // Constrain the width so the text genuinely wraps past the clamp.
    fixture.nativeElement.style.width = '300px';
    fixture.nativeElement.style.fontSize = '16px';
    fixture.nativeElement.style.lineHeight = '24px';
    document.body.appendChild(fixture.nativeElement);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [ExpandableTextComponent] }).compileComponents();
  });

  afterEach(() => fixture?.nativeElement.remove());

  it('renders every paragraph', async () => {
    await setUp(['One', 'Two', 'Three']);
    expect(fixture.nativeElement.querySelectorAll('p').length).toBe(3);
  });

  it('offers no toggle when the text fits inside the clamp', async () => {
    await setUp(['Short.']);
    expect(component.canToggle).toBe(false);
    expect(fixture.nativeElement.querySelector('button')).toBeNull();
  });

  it('offers a toggle when the text overflows the clamp', async () => {
    await setUp(long(4));
    expect(component.canToggle).toBe(true);
    expect(fixture.nativeElement.querySelector('button')).not.toBeNull();
  });

  it('clamps the collapsed height to the requested number of lines', async () => {
    await setUp(long(4), 3);
    const content = fixture.nativeElement.querySelector('.expandable__content') as HTMLElement;
    // 3 lines at the 24px line-height set above.
    expect(content.style.height).toBe('72px');
  });

  it('expands and collapses, exposing state via aria-expanded', async () => {
    await setUp(long(4));
    const button = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    expect(button.getAttribute('aria-expanded')).toBe('false');

    component.toggle();
    fixture.detectChanges();
    expect(component.expanded).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('true');

    component.toggle();
    fixture.detectChanges();
    expect(component.expanded).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('hides the fade edge once expanded', async () => {
    await setUp(long(4));
    const fade = fixture.nativeElement.querySelector('.expandable__fade') as HTMLElement;
    expect(fade.classList.contains('is-gone')).toBe(false);

    component.toggle();
    fixture.detectChanges();
    expect(fade.classList.contains('is-gone')).toBe(true);
  });

  it('stamps a stagger index on each paragraph for the reveal', async () => {
    await setUp(long(3));
    const paragraphs = fixture.nativeElement.querySelectorAll('p') as NodeListOf<HTMLElement>;
    expect(paragraphs[0].style.getPropertyValue('--i')).toBe('0');
    expect(paragraphs[2].style.getPropertyValue('--i')).toBe('2');
  });
});
