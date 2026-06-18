export type TimelineDeviceInsertActions = {
  addMidiClip: () => Promise<void>;
  addArpeggiator: () => void;
  addEq: () => void;
  addReverb: () => void;
  canWrite: boolean;
  canAddMidiClip: boolean;
  canAddArpeggiator: boolean;
  canAddEq: boolean;
  canAddReverb: boolean;
};
