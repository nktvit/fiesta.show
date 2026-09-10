import { TestBed } from '@angular/core/testing';
import { CardExpansionService, ExpandableCollection } from './card-expansion.service';

describe('CardExpansionService', () => {
  let service: CardExpansionService;

  const collection = (): ExpandableCollection & { closed: number } => {
    const owner = { closed: 0, close: () => { owner.closed++; } };
    return owner;
  };

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(CardExpansionService);
  });

  it('reports nothing open initially', () => {
    expect(service.anyOpen()).toBe(false);
  });

  it('flags open once a collection activates', () => {
    service.activate(collection());
    expect(service.anyOpen()).toBe(true);
  });

  it('closes the previously active collection when another activates', () => {
    const first = collection();
    const second = collection();

    service.activate(first);
    service.activate(second);

    expect(first.closed).toBe(1);
    expect(second.closed).toBe(0);
    expect(service.anyOpen()).toBe(true);
  });

  it('does not close a collection that re-activates itself', () => {
    const only = collection();

    service.activate(only);
    service.activate(only);

    expect(only.closed).toBe(0);
  });

  it('clears the open flag when the active collection deactivates', () => {
    const owner = collection();
    service.activate(owner);
    service.deactivate(owner);
    expect(service.anyOpen()).toBe(false);
  });

  it('ignores deactivation from a collection that is not active', () => {
    const active = collection();
    const stale = collection();

    service.activate(active);
    service.deactivate(stale);

    expect(service.anyOpen()).toBe(true);
  });
});
