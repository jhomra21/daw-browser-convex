export type TimelineDeviceInsertActions = {
  addMidiClip: () => Promise<void>;
  addArpeggiator: () => void;
  addEq: () => void;
  addSaturator: () => void;
  addDelay: () => void;
  addReverb: () => void;
  canWrite: boolean;
  canAddMidiClip: boolean;
  canAddArpeggiator: boolean;
  canAddEq: boolean;
  canAddSaturator: boolean;
  canAddDelay: boolean;
  canAddReverb: boolean;
};
