import { WebSocketServer } from 'ws';
import * as https from 'https';
import * as fs from 'fs';

import { calculateDamages, iterateSpell, spells, randomFromList, randomAI } from './helper.js';

let runningGames = {};

const ID_CHARS = [
	'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
	'1', '2', '3', '4', '5', '6', '7', '8', '9', '0'
];

function generateId() {
	let id = '';
	for (let i = 0; i < 4; i++) {
		id += randomFromList(ID_CHARS);
	}
	return id;
}

function createGame(ws, entity) {
	let id = generateId();
	while (Object.keys(runningGames).includes(id)) {
		id = generateId();
	}

	const turnState = {
		battleData: [generateBattleEntity(entity, false), null, null, null, null, null, null, null],
		selectedCards: [null, null, null, null, null, null, null, null],
		selectedVictims: [[], [], [], [], [], [], [], []],
		battleIndex: -2,
		aura: null
	};

	runningGames[id] = {
		id,
		turnState,
		sockets: [{
			ws,
			pos: 0,
			isReady: false,
			isHost: true
		}]
	};

	return id;
}

function propagateState(id) {
	const { sockets, turnState } = runningGames[id];
	sockets.forEach(({ ws, pos }) => ws.send(JSON.stringify({
		action: 'STATE_UPDATE',
		turnState,
		id,
		playerIndex: pos,
		players: sockets.map(({ pos, isReady, isHost }) => ({ pos, isReady, isHost }))
	})));
}

function joinGame(id, ws, entity) {
	if (gameExists(id) && runningGames[id].turnState.battleIndex === -2) {
		const nextEmptyPos = runningGames[id].turnState.battleData.findIndex(e => e === null);
		if (ws) {
			runningGames[id].sockets.push({
				ws,
				pos: nextEmptyPos,
				isReady: false,
				isHost: false
			});
		}
		runningGames[id].turnState.battleData[nextEmptyPos] = generateBattleEntity(entity, ws === undefined);
		return true;
	}
	return false;
}

function socketIsConnectedToGame(socket, id) {
	return runningGames[id].sockets.find(({ ws }) => socket === ws) !== undefined;
}

function gameExists(id) {
	return runningGames[id] !== undefined;
}

function checkWin(id) {
	const { turnState, sockets, leftStart, rightStart } = runningGames[id];
	if (turnState.battleData.filter((e, i) => i < 4 && e !== null).length === 0) {
		runningGames[id].turnState.battleIndex = -3;
		sockets.forEach(({ ws, pos }) => ws.send(JSON.stringify({
			action: 'WIN',
			side: 'RIGHT',
			entities: rightStart.map(({ entity }) => entity)
		})));
	} else if (turnState.battleData.filter((e, i) => i >= 4 && e !== null).length === 0) {
		runningGames[id].turnState.battleIndex = -3;
		sockets.forEach(({ ws, pos }) => ws.send(JSON.stringify({
			action: 'WIN',
			side: 'LEFT',
			entities: leftStart.map(({ entity }) => entity)
		})));
	}
}

/* Randomize array in-place using Durstenfeld shuffle algorithm */
function shuffleArray(array) {
	for (var i = array.length - 1; i > 0; i--) {
		var j = Math.floor(Math.random() * (i + 1));
		var temp = array[i];
		array[i] = array[j];
		array[j] = temp;
	}
}

function generateBattleEntity(entity, isAI) {
	const hasSuperVril = Math.random() <= entity.superVrilChance;

	return {
		shields: [],
		blades: [],
		vril: hasSuperVril ? 0 : 1,
		superVril: hasSuperVril ? 1 : 0,
		entity,
		isAI
	}
}

function setDeck(id, pos, battleDeck) {
	runningGames[id].turnState.battleData[pos].battleDeck = battleDeck;
}

function doRound(id) {
	let animationData = [];
	for (let i = 0; i < 8; i++) {
		runningGames[id].turnState.battleIndex = i;
		const victimIndices = runningGames[id].turnState.selectedVictims[runningGames[id].turnState.battleIndex]
			.filter(i => runningGames[id].turnState.battleData[i] !== null && runningGames[id].turnState.battleData[i].entity.health > 0);
		if (victimIndices.length > 0 && runningGames[id].turnState.battleData[runningGames[id].turnState.battleIndex].entity.health > 0) {
			const spellIndex = runningGames[id].turnState.selectedCards[runningGames[id].turnState.battleIndex];
			const spell = spells[runningGames[id].turnState.battleData[runningGames[id].turnState.battleIndex].hand[spellIndex].id];
			const enchantments = runningGames[id].turnState.battleData[runningGames[id].turnState.battleIndex].hand[spellIndex].enchantments;
			const doesSpellHit = Math.random() <= spell.chance + (enchantments?.accuracy || 0);
			const calculatedDamages = doesSpellHit
				? victimIndices.map(i => runningGames[id].turnState.battleData[i])
					.map(victimData => calculateDamages(
						spell,
						enchantments,
						runningGames[id].turnState.battleData[runningGames[id].turnState.battleIndex],
						victimData,
						runningGames[id].turnState.aura))
				: ['FAILED'];
			animationData.push({
				victimIndices: victimIndices.slice().reverse(),
				spell,
				calculatedDamages: calculatedDamages.slice().reverse(),
				turnState: JSON.parse(JSON.stringify(runningGames[id].turnState))
			});
			const iteration = iterateSpell(victimIndices, spellIndex, runningGames[id].turnState, calculatedDamages);
			runningGames[id].turnState.battleData = iteration.battleData;
			runningGames[id].turnState.aura = iteration.aura;
		}
	}

	for (let i = 0; i < runningGames[id].turnState.battleData.length; i++) {
		if (runningGames[id].turnState.battleData[i] && runningGames[id].turnState.battleData[i].entity.health > 0) {
			if (Math.random() <= runningGames[id].turnState.battleData[i].superVrilChance) {
				runningGames[id].turnState.battleData[i].superVril++;
			} else {
				runningGames[id].turnState.battleData[i].vril++;
			}
		} else if (runningGames[id].turnState.battleData[i] && runningGames[id].turnState.battleData[i].entity.health <= 0) {
			runningGames[id].turnState.battleData[i] = null;
		}
	}
	for (let i = 0; i < runningGames[id].turnState.battleData.length; i++) {
		if (!runningGames[id].turnState.battleData[i]) {
			continue;
		}
		while (runningGames[id].turnState.battleData[i].hand.length < 7) {
			const handSpell = runningGames[id].turnState.battleData[i].battleDeck.pop();
			if (!handSpell) {
				break;
			}
			runningGames[id].turnState.battleData[i].hand.push(handSpell);
		}
	}

	runningGames[id].turnState = {
		...runningGames[id].turnState,
		battleIndex: -1,
		selectedCards: [null, null, null, null, null, null, null, null],
		selectedVictims: [[], [], [], [], [], [], [], []],
	}

	return {
		animationData,
		finalTurnState: runningGames[id].turnState
	};
}

function shoveDownEntity(id, pos) {
	const limitPos = pos >= 4 ? 4 : 0;
	const { turnState, sockets } = runningGames[id];
	const socketIndex = sockets.findIndex(e => e.pos === pos);
	while (pos > limitPos && turnState.battleData[pos - 1] === null) {
		runningGames[id].turnState.battleData[pos - 1] = runningGames[id].turnState.battleData[pos];
		runningGames[id].turnState.battleData[pos] = null;
		pos--;
	}
	sockets[socketIndex].pos = pos;
}

function startGame(id) {
	unreadyAll(id);
	runningGames[id].turnState.battleIndex = -1;
	runningGames[id].leftStart = [];
	runningGames[id].rightStart = [];

	runningGames[id].sockets.forEach(({ ws }) => ws.send(JSON.stringify({
		action: 'START_BATTLE',
	})));

	for (let i = 0; i < runningGames[id].turnState.battleData.length; i++) {
		if (runningGames[id].turnState.battleData[i] === null) {
			continue;
		}

		if (i < 4) {
			runningGames[id].leftStart.push({
				ws: runningGames[id].turnState.battleData[i].entity.isAI ? null : runningGames[id].sockets.find(({ pos }) => pos === i).ws,
				entity: runningGames[id].turnState.battleData[i].entity
			});
		} else if (i >= 4) {
			runningGames[id].rightStart.push({
				ws: runningGames[id].turnState.battleData[i].entity.isAI ? null : runningGames[id].sockets.find(({ pos }) => pos === i).ws,
				entity: runningGames[id].turnState.battleData[i].entity
			});
		}

		if (runningGames[id].turnState.battleData[i].battleDeck === undefined) {
			runningGames[id].turnState.battleData[i].battleData = [...runningGames[id].turnState.battleData[i].entity.deck];
		}
		shuffleArray(runningGames[id].turnState.battleData[i].battleDeck);

		let hand = [];
		for (let i = 0; i < 7; i++) {
			const card = runningGames[id].turnState.battleData[i].battleDeck.pop();
			if (!card) {
				break;
			}
			hand.push(card);
		}
		runningGames[id].turnState.battleData[i].hand = hand;
	}
}

function areAllPlayersReady(id) {
	const { turnState } = runningGames[id];
	for (let i = 0; i < turnState.battleData.length; i++) {
		if (turnState.battleData[i] === null) {
			continue;
		}
		if (turnState.selectedCards[i] === null || (turnState.selectedCards[i] !== 'PASS' && turnState.selectedVictims[i].length === 0)) {
			return false;
		}
	}
	return true;
}

function startBattleSequence(id) {
	runningGames[id].turnState.battleIndex = 0;
	propagateState(id);
	const animationData = doRound(id);
	runningGames[id].sockets.forEach(({ ws }) => ws.send(JSON.stringify({
		action: 'BATTLE_ANIMATION_DATA',
		...animationData
	})));
	checkWin(id);
}

function unreadyAll(id) {
	runningGames[id].sockets.forEach(e => e.isReady = false);
}

function basicCheck(ws, id) {
	if (!gameExists(id)) {
		ws.send(JSON.stringify({
			action: "FAILURE",
			message: `Game '${id}' does not exist`
		}));
		return false;
	}
	if (!socketIsConnectedToGame(ws, id)) {
		ws.send(JSON.stringify({
			action: "FAILURE",
			message: `Socket is not connected to game '${id}'`
		}));
		return false;
	}
	return true;
}

const server = https.createServer({
	cert: fs.readFileSync('/etc/letsencrypt/live/wmgs.nallant.li/fullchain.pem'),
	key: fs.readFileSync('/etc/letsencrypt/live/wmgs.nallant.li/privkey.pem')
});

server.listen(8080);

const wss = new WebSocketServer({ server });

function processRequest(ws, data) {
	switch (data.action) {
		case 'CREATE_GAME': {
			const { entity } = data;
			const id = createGame(ws, entity);
			console.log(`${new Date(Date.now()).toISOString()} | Created Game: ${id} (Total Current Games: ${Object.entries(runningGames).length})`);
			propagateState(id);
			break;
		}
		case 'JOIN_GAME': {
			const { id, entity } = data;
			if (joinGame(id, ws, entity)) {
				unreadyAll(id);
				propagateState(id);
			} else {
				ws.send(JSON.stringify({
					action: "JOIN_FAILURE",
					message: `Cannot join game '${id}'`
				}));
				return;
			}
			break;
		}
		case 'ADD_ENTITY': {
			const { id, entity } = data;
			if (joinGame(id, undefined, entity)) {
				unreadyAll(id);
				propagateState(id);
			} else {
				ws.send(JSON.stringify({
					action: "FAILURE",
					message: `Cannot add entity to game '${id}'`
				}));
				return;
			}
			break;
		}
		case 'MOVE_ENTITY': {
			const { id, oldPos, newPos } = data;
			if (!basicCheck(ws, id)) {
				return;
			}
			if (runningGames[id].turnState.battleData[newPos] !== null) {
				ws.send(JSON.stringify({
					action: "FAILURE",
					message: `Position ${newPos} is already occupied`
				}));
				return;
			}
			if (runningGames[id].sockets.find(e => e.ws === ws)) {
				runningGames[id].sockets.find(e => e.ws === ws).pos = newPos;
			}
			runningGames[id].turnState.battleData[newPos] = runningGames[id].turnState.battleData[oldPos];
			runningGames[id].turnState.battleData[oldPos] = null;
			for (let i = 0; i < 8; i++) {
				if (runningGames[id].turnState.battleData[i] !== null) {
					shoveDownEntity(id, i);
				}
			}
			unreadyAll(id);
			propagateState(id);
			break;
		}
		case 'READY_UP': {
			const { id, deck } = data;
			if (!basicCheck(ws, id)) {
				return;
			}
			runningGames[id].sockets.find(e => e.ws === ws).isReady = true;
			setDeck(id, runningGames[id].sockets.find(e => e.ws === ws).pos, deck.map(id => ({ id })));
			if (runningGames[id].sockets.find(e => !e.isReady) === undefined) {
				startGame(id);
			}
			propagateState(id);
			break;
		}
		case 'READY_DOWN': {
			const { id } = data;
			if (!basicCheck(ws, id)) {
				return;
			}
			runningGames[id].sockets.find(e => e.ws === ws).isReady = false;
			propagateState(id);
			break;
		}
		case 'SELECT_CARD': {
			const { id, card } = data;
			if (!basicCheck(ws, id)) {
				return;
			}
			const playerIndex = runningGames[id].sockets.find(e => e.ws === ws).pos;
			runningGames[id].turnState.selectedCards[playerIndex] = card;
			if (areAllPlayersReady(id)) {
				startBattleSequence(id);
			} else {
				propagateState(id);
			}
			break;
		}
		case 'SELECT_VICTIMS': {
			const { id, victims } = data;
			if (!basicCheck(ws, id)) {
				return;
			}
			const playerIndex = runningGames[id].sockets.find(e => e.ws === ws).pos;
			runningGames[id].turnState.selectedVictims[playerIndex] = victims;
			if (areAllPlayersReady(id)) {
				startBattleSequence(id);
			} else {
				propagateState(id);
			}
			break;
		}
		case 'UPDATE_HAND': {
			const { id, hand } = data;
			if (!basicCheck(ws, id)) {
				return;
			}
			const playerIndex = runningGames[id].sockets.find(e => e.ws === ws).pos;
			runningGames[id].turnState.battleData[playerIndex].hand = hand;
			propagateState(id);
			break;
		}
	}
}

wss.on('connection', function connection(ws) {
	ws.on('close', (code, desc) => {
		console.log(`${new Date(Date.now()).toISOString()} | Closed connection`, code, desc);
		const game = Object.entries(runningGames).find(([_, value]) => {
			if (value && value.sockets.find(e => e.ws === ws)) {
				return true;
			}
			return false;
		});
		if (game) {
			const id = game[0];
			const wsIndex = runningGames[id].sockets.findIndex(e => e.ws === ws);
			const wasHost = runningGames[id].sockets[wsIndex].isHost;
			runningGames[id].turnState.battleData[runningGames[id].sockets[wsIndex].pos] = null;
			runningGames[id].sockets.splice(wsIndex, 1);
			if (runningGames[id].sockets.length === 0) {
				console.log(`${new Date(Date.now()).toISOString()} | Closing game ${id} (Total Current Games: ${Object.entries(runningGames).length - 1})`);
				delete runningGames[id];
			} else {
				if (runningGames[id].turnState.battleIndex === -2) {
					for (let i = 0; i < 8; i++) {
						if (runningGames[id].turnState.battleData[i] !== null) {
							shoveDownEntity(id, i);
						}
					}
				}
				if (wasHost) {
					runningGames[id].sockets[0].isHost = true;
				}
				propagateState(id);
				if (runningGames[id].turnState.battleIndex > -2) {
					checkWin(id);
				}
			}
		}
	});
	ws.on('message', (raw) => {
		const dataArray = JSON.parse(raw);
		dataArray.forEach(data => processRequest(ws, data));
	});

	ws.send(JSON.stringify({
		action: 'SUCCESS',
		message: 'Connected'
	}), ws);
});

console.log('Created WebSocket');