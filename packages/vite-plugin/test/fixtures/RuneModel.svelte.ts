export class RuneModel {
  count: number = $state(0);
  #secret: string = $state('internal');
  doubled: number = $derived(this.count * 2);
}

export const runeModel = new RuneModel();
