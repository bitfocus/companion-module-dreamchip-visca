import { INQUIRIES } from './commands.js'

export default function updateVariables(self) {
	self.setVariableDefinitions(Object.values(INQUIRIES).map((q) => ({ variableId: q.varId, name: q.name })))
}
