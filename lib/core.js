// 
//  core.js
//  mdo_prototype
//  
//  Created by Dmitry Shvetsov.
//  Copyright 2014 Dmitry Shvetsov. All rights reserved.
// 



var spell         = require('./spell.js'),
    Duel          = require('./duel.js'),
    Round         = require('./round.js'),
    Player        = require('./player.js'),
    UUId          = require('node-uuid'),
    _             = require('underscore');



var core = {
  /** 
   *  setOfDuels - a storage for all Duel objects.
   *  setOfPlayedDuels - the temporary solution for storing set of played duels
   */
  setOfDuels: {
    waitingFor: null
  },
  
  setOfPlayedDuels: [],
  
  
  
  /**
   *  init - initializes game and joins the initial player.
   *  addPlayer - join client it to the io room & emit to player
   *  listen - list of all sockets events to listen
   */
  init: function (ioSockets, client, duelId) {
    core.addPlayer(ioSockets, client, duelId);
    this.listen(client);
    
    var thisDuel = core.setOfDuels[duelId];
    stateMachine();
    
    function stateMachine () {
      if (thisDuel.state === 'wait') {
        /**
         * WAIT
         * Initial player waiting for opponent
         */
        
        ioSockets.in(duelId).emit('wait', thisDuel);
        
        // start next state machine loop
        setTimeout(stateMachine, thisDuel.refreshIn * 1000);
      } else if (thisDuel.state === 'countdown') {
        /**
         * COUNTDOWN
         * and change state to 'round'
         */
        
        ioSockets.in(duelId).emit('countdown', thisDuel);
        thisDuel.state = 'round';
        console.log('\t :: MDO server :: COUNTDOWN #' + thisDuel.nRound);
        
        // start next state machine loop
        setTimeout(stateMachine, thisDuel.refreshIn * 1000);
      } else if (thisDuel.state === 'result') {
        /**
         * RESULT
         * duel now have some result
         * make appropriate actions and set the duel status ended
         */
        
        thisDuel.state = 'endDuel';
        
        // start next state machine loop
        setTimeout(stateMachine, thisDuel.refreshIn * 1000);
      } else if (thisDuel.state === 'endDuel') {
        /**
         * END DUEL
         * If one of the player disconnected disconect other
         * remove game from memory
         * and quit from stateMachine loop
         */
        
        core.endDuel(ioSockets ,_.keys(thisDuel.players));
        
        // save played duel
        core.setOfPlayedDuels.push(thisDuel);
        
        delete core.setOfDuels[duelId];
        
        if (core.setOfDuels.waitingFor && core.setOfDuels.waitingFor.id === duelId) {
          core.setOfDuels.waitingFor = null;
        }
        console.log('\t :: MDO server :: END DUEL #' + thisDuel.id + ' is deleted');
        // interupt current state machine loop
        return;
      } else if (thisDuel.state === 'round') {
        /**
         * ROUND
         * prepare round and send to clients
         */
        
        core.addNewRound(thisDuel);
        ioSockets.in(duelId).emit('round', thisDuel);
        thisDuel.state = 'calculate';
        console.log('\n\t :: MDO server :: ROUND #' + thisDuel.rounds.length);
        console.log(_.last(thisDuel.rounds)); // TODO replace debugin by tests
        
        // start next state machine loop
        setTimeout(stateMachine, thisDuel.refreshIn * 1000);
      } else {
        /**
         * CALCULATE THE ROUND RESULT
         * make calculations and store for further sending to client
         */
        
        core.throwSpell(thisDuel);
        core.calcRound(thisDuel);
        
        // are players alive?
        var playersKey          = _.keys(thisDuel.players),
            thisRound           = _.last(thisDuel.rounds);
        
        if (thisRound[playersKey[0]].hp <= 0 && thisRound[playersKey[1]].hp <= 0) {
          thisRound[playersKey[0]].hp = 0;
          thisRound[playersKey[1]].hp = 0;
          core.setStateResult(thisDuel.id, null);
          ioSockets.in(duelId).emit('result', thisDuel);
        } else {
          for (var i = 0; i < 2; i++) {
            if (thisRound[playersKey[i]].hp <= 0) {
              thisRound[playersKey[i]].hp = 0;
              var winnerIndex = (i == 0) ? 1 : 0;
              core.setStateResult(thisDuel.id, playersKey[winnerIndex]);
              ioSockets.in(duelId).emit('result', thisDuel);
            }
          }
        }
        
        console.log('\n\t :: MDO server :: CALCULATE #' + thisDuel.nRound + ' (' + thisDuel.rounds.length + ')');
        console.log(thisRound); // TODO replace debugin by tests
        
        // after calculation start new loop step as quick as posible and interupt current loop
        ioSockets.in(duelId).emit('calculate', thisDuel);
        if (thisDuel.state != 'result') {
          thisDuel.state = 'round';
        }
        
        // start next state machine loop
        setTimeout(stateMachine, 1500);
      }
      
      /**
       * END OF STATE MACHINE
       */
    }
  },
  
  addPlayer: function (ioSockets, client, duelId) {
    client.join(duelId);
    ioSockets.in(duelId).emit('connected', core.setOfDuels[duelId]);
    core.listen(client);
    console.log('\t :: MDO server :: PLAYER connected ' + client.id + ' to ' + duelId + ' duel');
  },
  
  listen: function (client) {
    client.on('disconnect', function () {
      var rooms = _.keys(client.manager.rooms);
      _.each(rooms, function (room, index, list) {
        core.setStateEndDuel(room.substring(1)); // here we got at least two room, first one is '' and second that we need
      });
      console.log('\t :: MDO server :: PLAYER disconnected ' + client.id);
    });
    
    client.on('castSpell', function (data) {
      if (core.setOfDuels[data.duelId].rounds.length == 0) return null;
      var thisRound = _.last(core.setOfDuels[data.duelId].rounds);
      thisRound[data.playerId].actions = data.spell;
    });
  },
  
  
  
  /** 
   * throwSpell - put in to current round spell with all attributes
   * calcRound - wrapper for all functions that calculate round at it end
   * applySpell - apply a spell between subject and object
   */
  throwSpell: function (duel) {
    var thisRound         = _.last(duel.rounds);
    
    Object.getOwnPropertyNames(thisRound).forEach(function (playerId, index, players) {
      if (thisRound[playerId].actions) {
        var playerSpell  = spell[thisRound[playerId].actions];
        
        switch (playerSpell.school) {
        case 'abjuration':
          thisRound[playerId][playerSpell.effect] = {
            cost: playerSpell.cost,
            power: core.randMinMax(playerSpell.minDefence, playerSpell.maxDefence),
            critical: false
          };
          break;
        case 'enchantment':
          console.log('no handle for enchantment');
          break;
        case 'evocation':
          thisRound[playerId][playerSpell.effect] = {
            cost: playerSpell.cost,
            power: core.randMinMax(playerSpell.minDamage, playerSpell.maxDamage),
            critical: core.isCritical(playerSpell.criticalChance)
          };
          break
        case 'illusion':
          console.log('no handle for illusion');
          break;
        case 'transmutation':
          console.log('no handle for transmutation');
          break;
        }
        
        core.addToLog(thisRound[playerId], thisRound[playerId].actions, thisRound[playerId][playerSpell.effect].power);
      }
    });
  },
  
  calcRound: function (duel) {
    var playersKey          = _.keys(duel.players),
        thisRound           = _.last(duel.rounds),
        firstPlayerRound    = thisRound[playersKey[0]],
        secondPlayerRound   = thisRound[playersKey[1]];
    
    core.applySpell(firstPlayerRound, secondPlayerRound);
    core.applySpell(secondPlayerRound, firstPlayerRound);
  },
  
  /**
   * Apply throwed spells
   * @subject - who throw spell
   * @object - who receive spell
   */
  applySpell: function (subject, object) {
    var damageToObject = 0;
    
    if (subject.damage) {
      // if oject produce critical damage
      if (subject.damage.critical) { 
        object.hp = 0;
      }
      
      // if object try reflect subject spell else just deal damage on object
      if (object.reflect) {
        damageToObject += core.nlto(subject.damage.power - object.reflect.power);
      } else {
        damageToObject += subject.damage.power;
      }
      // collect total spells cost for subject caster of the spell
      subject.totalSpellCost += subject.damage.cost;
    }
    
    if (subject.reflect) {
      // calculate damage to reflect
      if (object.damage) {
        damageToObject += (subject.reflect.power > object.damage.power) ? object.damage.power : subject.reflect.power;
      } else {
        damageToObject += 0;
      }
      // collect total spells cost for subject caster of the spell
      subject.totalSpellCost += subject.reflect.cost;
    }
    
    // set total damage that object recieve
    object.totalDamageRecive = damageToObject;
    
    // substract total damage from object
    object.hp -= damageToObject;
    
    // substract the cost of spells from the caster
    subject.hp -= subject.totalSpellCost;
  },
  
  
  
  /** 
   *  App helper functions
   */
  handleNewPlayer: function (clientId, callback) {
    var player = new Player(clientId, 24);
    
    if (_.size(this.setOfDuels) === 0 || !this.setOfDuels.waitingFor) {
      callback(this.createNewDuel(player));
    } else {
      callback(this.joinToWaitingFor(player));
    }
  },
  
  createNewDuel: function (player) {
    var thisPlayer = {};
    thisPlayer[player.id] = player;
    
    var newDuel = new Duel(thisPlayer);
    
    this.setOfDuels[newDuel.id] = newDuel;
    this.setOfDuels.waitingFor = newDuel;
    
    return newDuel;
  },
  
  joinToWaitingFor: function (player) {
    var thisDuel = this.setOfDuels.waitingFor;
    
    thisDuel.players[player.id] = player;
    thisDuel.state = 'countdown';
    this.setOfDuels.waitingFor = null;
    
    return thisDuel;
  },
  
  addNewRound: function (duel) {
    var playersKey          = _.keys(duel.players),
        previousRound       = _.last(duel.rounds);
    
    if (previousRound) {
      var newRound = new Round(previousRound);
    } else {
      var newRound = new Round(duel.players);
    }
    
    duel.nRound = duel.rounds.push(newRound);
  },
  
  randMinMax: function (min, max) {
    return (Math.random() * (max - min + 1) + min) | 0;
  },
  
  isCritical: function (criticalChance) {
    return Math.random() >= (1.0 - criticalChance);
  },
  
  nlto: function (num) {
    if (num < 0) {
      return 0;
    } else {
      return num;
    }
  },
  
  addToLog: function (playerRound, action, power) {
    if (playerRound.damage && playerRound.damage.critical) {
      playerRound.log.push('throw spell ' + action + ' with critical ' + spell[action].effect);
    } else {
      playerRound.log.push('throw spell ' + action + ' with effect ' + spell[action].effect + ' and power ' + power);
    }
  },
  
  setStateResult: function (duelId, winnerPlayerId) {
    core.setOfDuels[duelId].result = {
      winner: winnerPlayerId,
      nRound: core.setOfDuels[duelId].nRound
    };
    core.setOfDuels[duelId].state = 'result';
  },
  
  setStateEndDuel: function (duelId) {
    if (!duelId || duelId === '') return;
    core.setOfDuels[duelId].state = 'endDuel';
  },
  
  endDuel: function (ioSockets, players) {
    players.forEach(function (player) {
      console.log('\t :: MDO server :: PLAYER ' + player + ' make sure that is disconnected');
      ioSockets.socket(player).disconnect();
    });
  }
}



exports = module.exports = core;