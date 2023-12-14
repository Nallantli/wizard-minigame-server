export const spells = await (await fetch('https://raw.githubusercontent.com/Nallantli/wizard-minigame/master/spells.json')).json();

function getSpell(id) {
	return spells[id];
}

export function randomFromList(l) {
	return l[Math.floor(Math.random() * l.length)];
}

function criticalChance(cra, crb) {
	const diff = cra - crb;
	return ((diff - 32) / (2 * (16 + Math.abs(diff - 32))) + 0.5) * (Math.min(cra, 100) / 100);
}

export function calculateDamages(spell, enchantments, caster, victim, aura) {
	if (spell.type !== 'ATTACK_ALL' && spell.type !== 'ATTACK_BASIC') {
		return {};
	}

	const isCritical = spell.element === caster.entity.element && Math.random() <= criticalChance(caster.entity.criticalRating, victim.entity.criticalRating);

	const shields = victim.shields;
	const blades = caster.blades;
	let usedBladeIds = [];
	let totalUsedBladeIds = [];
	let baseTilt = 1;
	if (aura) {
		aura.modifiers.forEach(({ element, value }) => {
			if (element === spell.element) {
				baseTilt *= value;
			}
		});
	}
	blades.forEach(({ id, value, element }, i) => {
		if ((spell.element === element || element === 'all') && !totalUsedBladeIds.includes(id)) {
			baseTilt *= (value + 100) / 100;
			totalUsedBladeIds.push(id);
			usedBladeIds.push({ index: i, id });
		}
	});
	let totalUsedShieldIds = [];
	return {
		isCritical,
		usedBladeIds,
		damages: spell.damages.map(d => {
			let rawBase = (d.damage !== undefined ? d.damage : (Math.random() * (d.maxDamage - d.minDamage) + d.minDamage)) * (d.isPer ? getTotalVril(caster, d.element) : 1);
			let base = rawBase - (enchantments?.damage ? enchantments.damage / spell.damages.length : 0);
			let usedShieldIds = [];
			let currentElement = d.element;
			for (let i = shields.length - 1; i >= 0; i--) {
				const { id, value, element, elementTo } = shields[i];
				if ((currentElement === element || element === 'all') && !totalUsedShieldIds.includes(id)) {
					if (value) {
						base += base * (value / 100);
					}
					if (elementTo) {
						currentElement = elementTo;
					}
					usedShieldIds.push({ index: i, id });
					totalUsedShieldIds.push(id);
				}
			}
			if (isCritical) {
				base *= 2;
			}
			let augment = victim.entity?.augments?.[currentElement];
			return {
				...d,
				damage: Math.round(base * baseTilt * (augment !== undefined ? augment : 1)),
				augmented: augment !== undefined ? (augment > 1 ? ' ++' : ' --') : undefined,
				usedShieldIds
			};
		})
	};
}

export function iterateSpell(victimIndices, spellIndex, turnState, calculatedDamages) {
	let { battleData, aura } = turnState;
	const casterIndex = turnState.battleIndex;
	if (calculatedDamages.length === 1 && calculatedDamages[0] === 'FAILED') {
		const handSpell = battleData[casterIndex].hand[spellIndex];
		battleData[casterIndex].battleDeck = [
			handSpell,
			...battleData[casterIndex].battleDeck
		];
		battleData[casterIndex].hand.splice(spellIndex, 1);
		return { aura, battleData };
	}
	const spell = spells[battleData[casterIndex].hand[spellIndex].id];
	switch (spell.type) {
		case 'AURA':
			aura = {
				id: spell.id,
				modifiers: spell.aura
			};
			break;
		case 'HEALING_BASIC':
			spell.heals.forEach(({ heal }) => battleData[victimIndices[0]].entity.health += heal);
			break;
		case 'ATTACK_BASIC':
		case 'ATTACK_ALL':
			{
				victimIndices.forEach((victimIndex, i) => {
					let newShields = [];
					const { usedBladeIds, damages } = calculatedDamages[i];
					damages.forEach(({ damage, usedShieldIds, steal }) => {
						for (let j = 0; j < battleData[victimIndex].shields.length; j++) {
							if (!usedShieldIds.map(({ index }) => index).includes(j)) {
								newShields.push(battleData[victimIndex].shields[j]);
							}
						}
						battleData[victimIndex].entity.health += damage;
						if (steal) {
							battleData[casterIndex].entity.health -= Math.round(damage * steal);
						}
					});
					battleData[casterIndex].blades = battleData[casterIndex].blades.filter((_, j) => !usedBladeIds.map(({ index }) => index).includes(j));
					battleData[victimIndex].shields = newShields;
				});
			}
			break;
	}
	if (spell.victimShields) {
		victimIndices.forEach(i => {
			battleData[i].shields = [
				...battleData[i].shields,
				...spell.victimShields
			];
		});
	}
	if (spell.casterShields) {
		battleData[casterIndex].shields = [
			...battleData[casterIndex].shields,
			...spell.casterShields
		];
	}
	if (spell.victimBlades) {
		victimIndices.forEach(i => {
			battleData[i].blades = [
				...battleData[i].blades,
				...spell.victimBlades
			];
		});
	}
	if (spell.casterBlades) {
		battleData[casterIndex].blades = [
			...battleData[casterIndex].blades,
			...spell.casterBlades
		];
	}

	if (isPer) {
		battleData[casterIndex].superVril = 0;
		battleData[casterIndex].vril = 0;
	} else {
		let vrilLeft = spell.vrilRequired;
		while (vrilLeft > 1 && battleData[casterIndex].superVril > 0) {
			battleData[casterIndex].superVril--;
			vrilLeft -= 2;
		}
		if (battleData[casterIndex].vril === 0) {
			battleData[casterIndex].superVril -= Math.ceil(vrilLeft / 2);
		} else {
			battleData[casterIndex].vril -= vrilLeft;
		}
	}
	battleData[casterIndex].hand.splice(spellIndex, 1);

	for (let i = 0; i < battleData.length; i++) {
		if (battleData[i] === null) {
			continue;
		}
		battleData[i].entity.health = Math.round(battleData[i].entity.health);
		if (battleData[i].entity.health > battleData[i].entity.maxHealth) {
			battleData[i].entity.health = battleData[i].entity.maxHealth;
		}
	}
	return {
		aura,
		battleData
	};
}

// -------------------------------------------------------------------------------------------------------------

const spellUseTypes = {
	TO_ALL: () => true,
	TO_SELF: (casterIndex, victimIndex) => casterIndex === victimIndex,
	TO_ALLIES: (casterIndex, victimIndex) => (casterIndex < 4 && victimIndex < 4) || (casterIndex >= 4 && victimIndex >= 4),
	TO_ENEMIES: (casterIndex, victimIndex) => (casterIndex < 4 && victimIndex >= 4) || (casterIndex >= 4 && victimIndex < 4)
};

function getTotalVril(data, element) {
	const { vril, superVril } = data;
	if (element === data.entity.element) {
		return superVril * 2 + vril;
	}
	return superVril + vril;
}

function canUseSpellOn(spell, casterIndex, victimIndex) {
	return spellUseTypes[spell.spellUseType](casterIndex, victimIndex);
}

export const randomAI = (index, battleData) => {
	const entityData = battleData[index];
	const accessibleCards = entityData.hand
		.map(({ id }, i) => ({ card: getSpell(id), i }))
		.filter(({ card: { vrilRequired, element } }) => getTotalVril(entityData, element) >= vrilRequired);

	const options = accessibleCards
		.map(({ card, i }) => ({
			i,
			d: battleData
				.map((e, i) => ({ e, selectedVictim: i }))
				.filter(({ e }) => e !== null)
				.filter(({ selectedVictim }) => canUseSpellOn(card, index, selectedVictim))
		}))
		.map(({ d, i }) => ({ selectedCard: i, options: d.map(({ selectedVictim }) => selectedVictim) }))
		.filter(({ options }) => options.length > 0);

	if (options.length === 0) {
		return {
			selectedCard: 'PASS'
		}
	}
	if (Math.random() < 0.1) {
		return {
			selectedCard: 'PASS',
			selectedVictims: []
		};
	}
	const selectedCardOptions = randomFromList(options);
	let selectedVictims = [];
	if (getSpell(entityData.hand[selectedCardOptions.selectedCard].id).type === 'ATTACK_ALL') {
		selectedVictims = battleData.map((e, i) => ({ e, i })).filter(({ e, i }) => e !== null && canUseSpellOn(getSpell(entityData.hand[selectedCardOptions.selectedCard].id), index, i)).map(({ i }) => i);
	} else {
		selectedVictims = [randomFromList(selectedCardOptions.options)];
	}
	return {
		selectedCard: selectedCardOptions.selectedCard,
		selectedVictims
	};
};

export function selectCardsForAI(battleState) {
	const { turnState } = battleState;
	turnState.battleData.forEach((battleEntity, i) => {
		if (!battleEntity) {
			return;
		}
		if (battleEntity.isAI) {
			const { selectedCard, selectedVictims } = randomAI(i, turnState.battleData);
			turnState.selectedCards[i] = selectedCard;
			turnState.selectedVictims[i] = selectedVictims;
		}
	});
}