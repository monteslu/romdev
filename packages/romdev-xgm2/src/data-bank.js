// Port of sgdk.xgm2tool.format.DataBank — a VGM data-block sample bank.

export class DataBank {
  /**
   * @param {VGMCommand} command
   */
  constructor(command) {
    if (!command.isDataBlock())
      throw new Error(
        `Incorrect sample data declaration at ${command
          .getOriginOffset()
          .toString(16)
          .toUpperCase()} !`
      );

    /** @type {number} */
    this.id = command.getDataBankId();

    /** @type {Uint8Array} */
    this.data = new Uint8Array(command.getDataBlockLen());

    // copy bank data
    this.data.set(command.data.subarray(7, 7 + this.data.length), 0);
  }

  /**
   * @param {number} offset
   * @returns {number}
   */
  getSample(offset) {
    return this.data[offset];
  }
}
