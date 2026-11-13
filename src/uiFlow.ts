export type RoomPanel='conversation'|'participants'|'private-context'|'shared-memory'|'connections';
export type RoomPanelFlags={participants:boolean;privateContext:boolean;sharedMemory:boolean;connections:boolean};
export function roomPanelFlags(panel:RoomPanel):RoomPanelFlags{return{participants:panel==='participants',privateContext:panel==='private-context',sharedMemory:panel==='shared-memory',connections:panel==='connections'}}
export function participantKindLabel(kind:string):string{switch(kind){case'human':return'Person';case'original_session':return'Existing AI conversation';case'model':return'Connected model';case'external_agent':return'External AI runtime';default:return'Participant'}}
export function canSendGroupMessage(panel:RoomPanel):boolean{return panel==='conversation'}
